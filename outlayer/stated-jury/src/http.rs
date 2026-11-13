use serde_json::{json, Value};
use stated_jury::{
    append_evidence_bytes, decode_evidence_body, redirect_target, validate_evidence_response,
    validate_evidence_url, EvidencePage, RunBudget, Stage, Transport, MODELS,
};
use url::Url;
use wasi::clocks::monotonic_clock;
use wasi::http::outgoing_handler;
use wasi::http::types::{
    Fields, FutureIncomingResponse, IncomingBody, IncomingResponse, Method, OutgoingBody,
    OutgoingRequest, RequestOptions, Scheme,
};
use wasi::io::poll::{poll, Pollable};
use wasi::io::streams::StreamError;
use wasi::io::streams::{InputStream, OutputStream};

const API: &str = "https://cloud-api.near.ai/v1/chat/completions";
const RESPONSE_LIMIT: usize = 1_000_000;

pub struct Https {
    key: String,
    budget: Option<RunBudget>,
}

impl Https {
    pub fn from_secret() -> Result<Self, String> {
        let key = std::env::var("NEARAI_API_KEY")
            .map_err(|_| "Encrypted NEARAI_API_KEY secret is missing")?;
        if key.is_empty() || key.bytes().any(|b| b.is_ascii_control()) {
            return Err("Invalid inference secret".into());
        }
        Ok(Self { key, budget: None })
    }

    fn deadline(&self) -> Result<u64, String> {
        self.budget
            .as_ref()
            .ok_or("Run has not started")?
            .deadline(monotonic_clock::now())
    }

    fn check_deadline(deadline: u64) -> Result<u64, String> {
        deadline
            .checked_sub(monotonic_clock::now())
            .filter(|left| *left > 0)
            .ok_or_else(|| "timeout".into())
    }

    fn wait(event: Pollable, deadline: u64) -> Result<(), String> {
        Self::check_deadline(deadline)?;
        let timer = monotonic_clock::subscribe_instant(deadline);
        poll(&[&event, &timer]);
        Self::check_deadline(deadline).map(|_| ())
    }

    fn prepare(
        &self,
        url: &str,
        payload: Option<&str>,
        deadline: u64,
    ) -> Result<(FutureIncomingResponse, OutgoingBody), String> {
        if payload.is_some() && url != API {
            return Err("Inference endpoint mismatch".into());
        }
        if payload.is_none() {
            validate_evidence_url(url)?;
        }
        let parsed = Url::parse(url).map_err(|_| "Invalid HTTPS URL")?;
        let host = parsed
            .host_str()
            .ok_or("HTTPS host required")?
            .trim_end_matches('.');
        let path = match parsed.query() {
            Some(query) => format!("{}?{query}", parsed.path()),
            None => parsed.path().to_owned(),
        };
        let fields = Fields::new();
        fields
            .set(
                &"accept".into(),
                &[if payload.is_some() {
                    b"application/json".to_vec()
                } else {
                    b"text/html, text/plain, application/json, application/xhtml+xml".to_vec()
                }],
            )
            .map_err(|_| "Invalid accept header")?;
        fields
            .set(&"user-agent".into(), &[b"StatedBot/0.1".to_vec()])
            .map_err(|_| "Invalid agent header")?;
        if payload.is_some() {
            fields
                .set(
                    &"authorization".into(),
                    &[format!("Bearer {}", self.key).into_bytes()],
                )
                .map_err(|_| "Invalid authorization header")?;
            fields
                .set(&"content-type".into(), &[b"application/json".to_vec()])
                .map_err(|_| "Invalid content type")?;
            fields
                .set(&"x-no-aliasing".into(), &[b"true".to_vec()])
                .map_err(|_| "Invalid alias header")?;
        }
        let request = OutgoingRequest::new(fields);
        request
            .set_method(&if payload.is_some() {
                Method::Post
            } else {
                Method::Get
            })
            .map_err(|_| "Invalid method")?;
        request
            .set_scheme(Some(&Scheme::Https))
            .map_err(|_| "Invalid scheme")?;
        request
            .set_authority(Some(host))
            .map_err(|_| "Invalid authority")?;
        request
            .set_path_with_query(Some(&path))
            .map_err(|_| "Invalid path")?;
        let body = request.body().map_err(|_| "Cannot create request body")?;
        let options = RequestOptions::new();
        let nanos = Some(Self::check_deadline(deadline)?);
        options
            .set_connect_timeout(nanos)
            .map_err(|_| "Cannot set connect timeout")?;
        options
            .set_first_byte_timeout(nanos)
            .map_err(|_| "Cannot set response timeout")?;
        options
            .set_between_bytes_timeout(nanos)
            .map_err(|_| "Cannot set body timeout")?;
        // Start the request before writing: a large body must be consumed by the
        // host while we write, or the output stream can deadlock on backpressure.
        let future =
            outgoing_handler::handle(request, Some(options)).map_err(|_| "HTTPS request failed")?;
        Ok((future, body))
    }

    fn start(
        &self,
        url: &str,
        payload: Option<&str>,
        deadline: u64,
    ) -> Result<FutureIncomingResponse, String> {
        let (future, body) = self.prepare(url, payload, deadline)?;
        if let Some(payload) = payload {
            let stream = body.write().map_err(|_| "Cannot open request stream")?;
            let mut remaining = payload.as_bytes();
            while !remaining.is_empty() {
                Self::check_deadline(deadline)?;
                let capacity = stream.check_write().map_err(|_| "Cannot write request")?;
                if capacity == 0 {
                    Self::wait(stream.subscribe(), deadline)?;
                    continue;
                }
                let count = remaining.len().min(capacity.min(4096) as usize);
                stream
                    .write(&remaining[..count])
                    .map_err(|_| "Cannot write request")?;
                remaining = &remaining[count..];
            }
            stream.flush().map_err(|_| "Cannot flush request")?;
            // check_write becomes ready only once the flush has completed.
            loop {
                Self::check_deadline(deadline)?;
                if stream.check_write().map_err(|_| "Cannot flush request")? > 0 {
                    break;
                }
                Self::wait(stream.subscribe(), deadline)?;
            }
        }
        Self::check_deadline(deadline)?;
        OutgoingBody::finish(body, None).map_err(|_| "Cannot finish request")?;
        Ok(future)
    }

    fn receive(
        future: FutureIncomingResponse,
        limit: usize,
        deadline: u64,
    ) -> Result<String, String> {
        let response = loop {
            Self::check_deadline(deadline)?;
            if let Some(result) = future.get() {
                break result
                    .map_err(|_| "Response already consumed")?
                    .map_err(|_| "HTTPS response failed")?;
            }
            Self::wait(future.subscribe(), deadline)?;
        };
        Self::read_body(response, limit, deadline)
    }

    fn read_body(
        response: IncomingResponse,
        limit: usize,
        deadline: u64,
    ) -> Result<String, String> {
        if !(200..300).contains(&response.status()) {
            return Err("HTTPS status rejected (redirects disabled)".into());
        }
        let body = response.consume().map_err(|_| "Cannot consume response")?;
        let stream = body.stream().map_err(|_| "Cannot open response stream")?;
        let mut bytes = Vec::new();
        loop {
            Self::check_deadline(deadline)?;
            match stream.read(4096) {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        Self::wait(stream.subscribe(), deadline)?;
                        continue;
                    }
                    if bytes.len() + chunk.len() > limit {
                        return Err("HTTPS response exceeds the limit".into());
                    }
                    bytes.extend(chunk);
                }
                Err(StreamError::Closed) => break,
                Err(_) => return Err("Cannot read HTTPS response".into()),
            }
        }
        String::from_utf8(bytes).map_err(|_| "Response is not UTF8".into())
    }

    fn payload(model: &str, system: &str, input: &str) -> Result<String, String> {
        serde_json::to_string(&json!({"model":model,"stream":false,"response_format":{"type":"json_object"},"max_tokens":8192,
            "messages":[{"role":"system","content":system},{"role":"user","content":input}]})).map_err(|_| "Cannot encode completion request".into())
    }

    fn content(body: &str) -> Result<String, String> {
        let value: Value = serde_json::from_str(body).map_err(|_| "Invalid completion response")?;
        let id = value["id"].as_str().ok_or("Missing completion ID")?;
        if id.is_empty()
            || id.len() > 200
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("Invalid completion ID".into());
        }
        value["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_owned)
            .ok_or("Missing completion content".into())
    }

    fn start_jury(
        &self,
        system: &str,
        input: &str,
        deadline: u64,
    ) -> Result<Vec<FutureIncomingResponse>, String> {
        struct Writing {
            stream: Option<OutputStream>, // drop child before body on every exit path
            body: Option<OutgoingBody>,
            payload: String,
            offset: usize,
            flushing: bool,
        }
        let mut futures = Vec::with_capacity(MODELS.len());
        let mut writing = Vec::with_capacity(MODELS.len());
        // Create every request before waiting for any payload's output capacity.
        for model in MODELS {
            let payload = Self::payload(model, system, input)?;
            let (future, body) = self.prepare(API, Some(&payload), deadline)?;
            let stream = body.write().map_err(|_| "Cannot open request stream")?;
            futures.push(future);
            writing.push(Writing {
                stream: Some(stream),
                body: Some(body),
                payload,
                offset: 0,
                flushing: false,
            });
        }
        while writing.iter().any(|item| item.stream.is_some()) {
            Self::check_deadline(deadline)?;
            for item in &mut writing {
                let Some(stream) = &item.stream else { continue };
                let capacity = stream
                    .check_write()
                    .map_err(|_| "Cannot write jury request")?;
                if capacity == 0 {
                    continue;
                }
                if item.flushing {
                    item.stream = None;
                    let body = item.body.take().ok_or("Missing jury request body")?;
                    OutgoingBody::finish(body, None).map_err(|_| "Cannot finish jury request")?;
                    continue;
                }
                let count = (item.payload.len() - item.offset).min(capacity.min(4096) as usize);
                stream
                    .write(&item.payload.as_bytes()[item.offset..item.offset + count])
                    .map_err(|_| "Cannot write jury request")?;
                item.offset += count;
                if item.offset == item.payload.len() {
                    stream.flush().map_err(|_| "Cannot flush jury request")?;
                    item.flushing = true;
                }
            }
            let mut events: Vec<_> = writing
                .iter()
                .filter_map(|item| item.stream.as_ref().map(OutputStream::subscribe))
                .collect();
            if events.is_empty() {
                break;
            }
            events.push(monotonic_clock::subscribe_instant(deadline));
            poll(&events.iter().collect::<Vec<_>>());
        }
        Self::check_deadline(deadline)?;
        Ok(futures)
    }
}

impl Transport for Https {
    fn begin_run(&mut self) {
        self.budget = Some(RunBudget::new(monotonic_clock::now()));
    }

    fn set_stage(&mut self, stage: Stage) -> Result<(), String> {
        self.budget
            .as_mut()
            .ok_or("Run has not started")?
            .set_stage(stage, monotonic_clock::now())
            .map(|_| ())
    }

    fn get(&mut self, url: &str, limit: usize) -> Result<String, String> {
        let deadline = self
            .deadline()?
            .min(monotonic_clock::now().saturating_add(10_000_000_000));
        let future = self.start(url, None, deadline)?;
        Self::receive(future, limit, deadline)
    }
    fn evidence_pages(&mut self, urls: &[&str], limit: usize) -> Result<Vec<EvidencePage>, String> {
        // Start every request before polling. Each request keeps its original index;
        // a faster later response cannot reorder evidence or borrow another source's URL.
        if urls.len() > 8 {
            return Err("At most eight sources are allowed".into());
        }
        struct Pending {
            future: Option<FutureIncomingResponse>,
            stream: Option<InputStream>, // drop the child stream before its body
            _body: Option<IncomingBody>,
            deadline: u64,
            url: String,
            redirects: usize,
            bytes: Vec<u8>,
            content_type: String,
            result: Option<EvidencePage>,
        }
        let stage_deadline = self.deadline()?;
        let mut pending = Vec::with_capacity(urls.len());
        for url in urls {
            let deadline =
                stage_deadline.min(monotonic_clock::now().saturating_add(10_000_000_000));
            let mut item = Pending {
                future: None,
                stream: None,
                _body: None,
                deadline,
                url: String::new(),
                redirects: 0,
                bytes: Vec::new(),
                content_type: String::new(),
                result: None,
            };
            let request = validate_evidence_url(url).and_then(|_| {
                let normalized = Url::parse(url)
                    .map_err(|_| "Invalid HTTPS URL")?
                    .to_string();
                item.url = normalized;
                self.start(&item.url, None, deadline)
            });
            match request {
                Ok(future) => item.future = Some(future),
                Err(error) => {
                    let mut page = EvidencePage::unreadable(error);
                    if !item.url.is_empty() {
                        page.final_url = Some(item.url.clone());
                    }
                    item.result = Some(page);
                }
            }
            pending.push(item);
        }
        while pending.iter().any(|item| item.result.is_none()) {
            for item in pending.iter_mut().filter(|item| item.result.is_none()) {
                let progress = (|| -> Result<(), String> {
                    Self::check_deadline(item.deadline)?;
                    if let Some(future) = &item.future {
                        if let Some(result) = future.get() {
                            let response = result
                                .map_err(|_| "Response already consumed")?
                                .map_err(|_| "Evidence HTTPS response failed")?;
                            let status = response.status();
                            let headers = response.headers();
                            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                                let locations = headers.get(&"location".into());
                                let location = match locations.as_slice() {
                                    [value] => Some(
                                        std::str::from_utf8(value)
                                            .map_err(|_| "Invalid redirect location")?,
                                    ),
                                    [] => None,
                                    _ => return Err("Multiple redirect locations".into()),
                                };
                                let next = redirect_target(&item.url, location, item.redirects)?;
                                // The helper validates every hop before any outgoing request.
                                item.url = Url::parse(&next)
                                    .map_err(|_| "Invalid redirect URL")?
                                    .to_string();
                                item.redirects += 1;
                                item.future = Some(self.start(&item.url, None, item.deadline)?);
                                return Ok(());
                            }
                            if !(200..300).contains(&status) {
                                return Err(format!("status {status}"));
                            }
                            let types = headers
                                .get(&"content-type".into())
                                .into_iter()
                                .map(|value| {
                                    String::from_utf8(value)
                                        .map_err(|_| "Invalid evidence content type")
                                })
                                .collect::<Result<Vec<_>, _>>()?;
                            item.content_type = validate_evidence_response(status, &types)?;
                            let body = response
                                .consume()
                                .map_err(|_| "Cannot consume evidence response")?;
                            item.stream =
                                Some(body.stream().map_err(|_| "Cannot open evidence stream")?);
                            item._body = Some(body);
                            item.future = None;
                        }
                    }
                    if let Some(stream) = &item.stream {
                        match stream.read(4096) {
                            Ok(chunk) => {
                                if append_evidence_bytes(&mut item.bytes, &chunk, limit) {
                                    item.result = Some(EvidencePage::read(
                                        decode_evidence_body(&item.bytes)?,
                                        item.content_type.clone(),
                                        Some(item.url.clone()),
                                    ));
                                }
                            }
                            Err(StreamError::Closed) => {
                                item.result = Some(EvidencePage::read(
                                    decode_evidence_body(&item.bytes)?,
                                    item.content_type.clone(),
                                    Some(item.url.clone()),
                                ));
                            }
                            Err(_) => return Err("Cannot read evidence HTTPS body".into()),
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = progress {
                    let mut page = EvidencePage::unreadable(error);
                    if !item.url.is_empty() {
                        page.final_url = Some(item.url.clone());
                    }
                    item.result = Some(page);
                }
                if item.result.is_some() {
                    item.stream = None;
                    item._body = None;
                    item.future = None;
                    // Completed pages retain decoded text only, never a duplicate raw body.
                    item.bytes = Vec::new();
                }
            }
            let remaining: Vec<_> = pending
                .iter()
                .filter(|item| item.result.is_none())
                .collect();
            if remaining.is_empty() {
                break;
            }
            let deadline = remaining
                .iter()
                .map(|item| item.deadline)
                .min()
                .ok_or("Missing evidence deadline")?;
            let timer = monotonic_clock::subscribe_instant(deadline);
            let mut events = Vec::with_capacity(remaining.len() + 1);
            for item in &remaining {
                if let Some(future) = &item.future {
                    events.push(future.subscribe());
                } else if let Some(stream) = &item.stream {
                    events.push(stream.subscribe());
                }
            }
            events.push(timer);
            poll(&events.iter().collect::<Vec<_>>());
        }
        pending
            .into_iter()
            .map(|item| {
                let mut page = item.result.ok_or("Missing evidence result")?;
                page.redirected = item.redirects > 0;
                Ok(page)
            })
            .collect()
    }
    fn complete(&mut self, model: &str, system: &str, input: &str) -> Result<String, String> {
        let deadline = self.deadline()?;
        let future = self.start(API, Some(&Self::payload(model, system, input)?), deadline)?;
        Self::content(&Self::receive(future, RESPONSE_LIMIT, deadline)?)
    }
    fn complete_jury(&mut self, system: &str, input: &str) -> Result<Vec<String>, String> {
        // Three outstanding HTTP requests, no threads (WASI does not support std::thread).
        let deadline = self.deadline()?;
        let futures = self.start_jury(system, input, deadline)?;
        futures
            .into_iter()
            .map(|f| Self::content(&Self::receive(f, RESPONSE_LIMIT, deadline)?))
            .collect()
    }
}
