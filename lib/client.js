// SPDX-License-Identifier: MIT
// dsh-voice-scribe — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-voice-scribe/client.js (the
// route is derived from the PACKAGE NAME, which must match the id below) and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's module table — the same shape the
// shipped ui-* packages' tsdown bundles emit.
//
// Interaction: tap Alt (or Alt+Space, configurable) to start recording, tap
// again to stop and transcribe. The transcript is inserted at the composer
// textarea's cursor, preserving the existing draft. Optional polish re-runs
// the text through the DSH-configured LLM (host route /voice-input/polish).
//
// Privacy: audio is sent to the host route /voice-input/transcribe which
// forwards it to the configured ASR endpoint. The ASR API key lives only in
// the host settings file — the browser never sees it.

window.__ModuleLoader__.load({
	id: "dsh-voice-polish",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _react = require("react");

		//#region constants & settings
		/** localStorage keys (same-origin persistence, mirrors dsh-dream-skin). */
		const SETTINGS_KEY = "dsh-voice-input:settings";
		const ENGINE_KEY = "dsh-voice-input:engine";
		const HOTKEY_KEY = "dsh-voice-input:hotkey";
		const POLISH_KEY = "dsh-voice-input:polish";
		const POLISH_MODEL_KEY = "dsh-voice-input:polish-model";
		const LANGUAGE_KEY = "dsh-voice-input:language";
		/** Trigger mode: "tap" = press to toggle, "hold" = push-to-talk. */
		const MODE_KEY = "dsh-voice-input:mode";
		const MODES = ["tap", "hold"];
		/**
		 * Capture device: "" = let the browser resolve the default, otherwise a
		 * MediaDeviceInfo.deviceId. A device-less getUserMedia({audio:true}) is
		 * answered by the BROWSER's own picker (Chrome: the site's microphone
		 * choice, else its profile-level device ranking), which can differ from the
		 * OS default and can land on a silent virtual device — the pill still says
		 * "录音中", the level meter stays flat and nothing is transcribed.
		 */
		const DEVICE_KEY = "dsh-voice-input:device";
		/** Peak |sample| below which a take counts as silence (0..1 scale). */
		const SILENT_PEAK_THRESHOLD = 0.005;
		/** v0.2 migration marker: pre-0.2.0 persisted the old "web-speech"
		 *  default; upgraders must land on the new "auto" default instead. */
		const ENGINE_MIGRATED_KEY = "dsh-voice-input:engine-migrated-v2";
		/** Default ASR settings (mirror the host defaults; the key is never here). */
		const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
		const DEFAULT_ASR_MODEL = "whisper-large-v3";
		/** Hotkeys: "alt" (single tap) or "alt-space" (fallback when the browser eats Alt). */
		const HOTKEYS = ["alt", "alt-space"];
		/** Custom hotkey storage prefix: "custom:<combo>" where combo is a
		 *  canonical "+"-joined chord ("ctrl+shift+v", "f9", "alt+space", …).
		 *  The "custom" option in settings records any key combination. */
		const CUSTOM_HOTKEY_PREFIX = "custom:";
		/** API prefix (must match lib/index.js). */
		const API_PREFIX = "/voice-input";
		/** Debounce so a quick double-tap of Alt does not toggle twice. */
		const HOTKEY_DEBOUNCE_MS = 250;
		/** How long to wait for SpeechRecognition.onend after stop() before giving */
		/** up on it and finishing the transcript ourselves. */
		const WS_STOP_WATCHDOG_MS = 12_000;
		//#endregion

		//#region host API helpers
		/** Timeout for one host call (audio transcribe can legitimately take a while). */
		const HOST_CALL_TIMEOUT_MS = 75_000;
		/** Local CPU inference runs ~0.3× realtime: a max-size (~4.7 min) recording
		 *  needs ~90 s, so the generic 75 s cap could cut a valid decode short. */
		const LOCAL_TRANSCRIBE_TIMEOUT_MS = 180_000;
		/** The LOCAL engine uploads RAW 16 kHz float32 PCM (4 bytes/sample):
		 *  past ~4.7 min the request body exceeds the host's 24 MB cap and the
		 *  transcription fails with 413 mid-flow. Auto-stop just under that so
		 *  a long dictation ends cleanly instead. */
		const LOCAL_MAX_RECORDING_MS = 260_000;
		/** Cloud engines upload COMPRESSED audio (webm/ogg) — the 10 min cap is
		 *  a memory bound, not a hard transport limit. */
		const CLOUD_MAX_RECORDING_MS = 600_000;
		/** Host-side timeout for ONE cloud ASR provider (mirrors host-utils). */
		const ASR_PROVIDER_TIMEOUT_MS = 60_000;
		const hostControllers = new Set();

		async function hostCall(body, timeoutMs) {
			const controller = new AbortController();
			hostControllers.add(controller);
			const timer = setTimeout(() => controller.abort(), timeoutMs || HOST_CALL_TIMEOUT_MS);
			try {
				const res = await fetch(API_PREFIX, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal
				});
				let data = null;
				try { data = await res.json(); } catch { /* non-JSON */ }
				return data;
			} catch (error) {
				if (error && error.name === "AbortError") {
					const timeout = new Error("host call timed out");
					timeout.code = "host-timeout";
					throw timeout;
				}
				throw error;
			} finally {
				clearTimeout(timer);
				hostControllers.delete(controller);
			}
		}

		/**
		 * Transcribe and return { ok, text?, error? } — the caller needs the
		 * host's error code/message (asr-key-missing, asr-timeout, 401…), not
		 * just a boolean, so the status bar can show the real cause.
		 */
		async function transcribe(audioBase64, mimeType, language) {
			try {
				// The host tries its provider chain SEQUENTIALLY at up to 60 s each, so a
			// fixed 75 s client cap aborted a chain the user configured on purpose
			// (and the abort then killed the in-flight provider).
			const timeoutMs = HOST_CALL_TIMEOUT_MS + ASR_PROVIDER_TIMEOUT_MS * (hostProviderCount - 1);
			const data = await hostCall({ action: "transcribe", audio: audioBase64, mimeType, language: language || "" }, timeoutMs);
				if (data && data.ok === true && typeof data.text === "string") return { ok: true, text: data.text };
				const msg = data && data.error && typeof data.error.message === "string" ? data.error.message : "转写失败";
				return { ok: false, error: msg };
			} catch (error) {
				return { ok: false, error: error && error.code === "host-timeout" ? "请求超时" : (error && error.message ? error.message : "转写失败") };
			}
		}

		async function polish(text, provider, model) {
			try {
				const data = await hostCall({ action: "polish", text, provider, model });
				// Never lose the transcript: only accept a real polished string.
				return data && data.ok === true && typeof data.text === "string" && data.text.trim() !== "" ? data.text : text;
			} catch {
				// Host unreachable / aborted — keep the raw transcript.
				return text;
			}
		}

		async function listModels() {
			const data = await hostCall({ action: "list-models" });
			return data && data.ok === true && Array.isArray(data.value) ? data.value : [];
		}

		async function fetchSettings() {
			const data = await hostCall({ action: "get-settings" });
			return data && data.ok === true && data.value ? data.value : null;
		}

		async function saveSettings(patch) {
			const data = await hostCall({ action: "set-settings", patch });
			return data && data.ok === true;
		}
		//#endregion

		//#region settings read/write (localStorage mirror)
		function readJson(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : JSON.parse(raw);
			} catch {
				return fallback;
			}
		}
		function writeJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch {
				// storage unavailable
			}
		}

		function readHotkey() {
			const v = readJson(HOTKEY_KEY, "alt");
			if (HOTKEYS.indexOf(v) >= 0) return v;
			if (typeof v === "string" && v.indexOf(CUSTOM_HOTKEY_PREFIX) === 0) {
				// Only accept well-formed custom combos; anything else falls back.
				return parseHotkeyCombo(v.slice(CUSTOM_HOTKEY_PREFIX.length)) ? v : "alt";
			}
			return "alt";
		}
		/** The saved custom chord (canonical string) or null when a preset is active. */
		function readCustomHotkeyCombo() {
			const v = readHotkey();
			if (typeof v === "string" && v.indexOf(CUSTOM_HOTKEY_PREFIX) === 0) return v.slice(CUSTOM_HOTKEY_PREFIX.length);
			return null;
		}
		/** Trigger mode: "tap" (press once to start, again to stop) or
		 *  "hold" (push-to-talk: hold the key, release to transcribe). */
		function readMode() {
			const v = readJson(MODE_KEY, "tap");
			return MODES.indexOf(v) >= 0 ? v : "tap";
		}
		/**
		 * Recognition engine:
		 *   "auto" (default) — use the local SenseVoice engine when its model is
		 *     ready, otherwise Web Speech; on a Web Speech network error, switch
		 *     to local automatically (downloads the model on first use). Zero
		 *     config, zero key, and immune to blocked Google / Edge regressions.
		 *   "web-speech" — browser built-in (Google/Microsoft backend).
		 *   "local" — host-side SenseVoice via sherpa-onnx (offline, private).
		 *   "cloud-asr" — OpenAI-compatible endpoint (requires an API key).
		 */
		function readEngine() {
			// One-time migration (v0.2): the pre-0.2.0 default was "web-speech";
			// upgrading users must get the new "auto" default, otherwise they
			// stay on Web Speech (broken on Edge Stable / blocked Google) with
			// no auto-fallback to the local engine.
			if (readJson(ENGINE_MIGRATED_KEY, false) !== true) {
				writeJson(ENGINE_KEY, "auto");
				writeJson(ENGINE_MIGRATED_KEY, true);
			}
			const v = readJson(ENGINE_KEY, "auto");
			return v === "web-speech" || v === "local" || v === "cloud-asr" || v === "auto" ? v : "auto";
		}

		/** Cached local-model readiness (refreshed at boot and after downloads). */
		let localReady = false;
		/** Cloud ASR providers in the host failover chain (1 = single endpoint). */
		let hostProviderCount = 1;
		/**
		 * Must match MAX_ASR_PROVIDERS in lib/index.js. Rows past that cap are
		 * dropped when saving, and until now the UI happily let the user create
		 * them: the 5th row stayed on screen, reported "已保存", never ran, and
		 * silently disappeared on reload.
		 */
		const MAX_ASR_PROVIDERS = 4;

		/** Remember the host's provider count so the cloud call timeout can scale. */
		function applyHostSettings(value) {
			if (!value || typeof value !== "object") return;
			const count = Array.isArray(value.providers) ? value.providers.length : 0;
			hostProviderCount = Math.max(1, count);
		}

		/** Resolve the effective engine for the next recording. */
		function effectiveEngine() {
			const engine = readEngine();
			if (engine === "auto") return localReady ? "local" : "web-speech";
			return engine;
		}
		function readLanguage() {
			const v = readJson(LANGUAGE_KEY, "");
			return typeof v === "string" ? v : "";
		}
		function readPolishEnabled() {
			return readJson(POLISH_KEY, false) === true;
		}
		function readPolishModel() {
			const v = readJson(POLISH_MODEL_KEY, null);
			return v !== null && typeof v === "object" ? v : null; // { provider, model }
		}
		/** Pinned capture deviceId ("" = whatever the browser resolves). */
		function readDeviceId() {
			const v = readJson(DEVICE_KEY, "");
			return typeof v === "string" ? v : "";
		}
		function writeDeviceId(id) {
			writeJson(DEVICE_KEY, typeof id === "string" ? id : "");
		}
		//#endregion

		//#region capture device (which microphone is actually recording)
		/** Cached enumerateDevices() audioinput entries. Their labels stay EMPTY
		 *  until the microphone was granted at least once, so the settings row must
		 *  never call getUserMedia just to fill them in (that would light the mic
		 *  indicator on a settings page). */
		let audioInputs = [];
		/** Label of the device the current (or last) recording really captured from. */
		let activeDeviceLabel = "";
		/**
		 * Peak |sample| seen during the current take (null = "unknown": the meter
		 * never ran, or the take has not started). Reset at every start and only
		 * set to a number once the analyser is live, so the empty-transcript hint
		 * never claims "silence" on the strength of a meter that never ran. It
		 * deliberately survives stopLevelMeter() — the hint is rendered later.
		 */
		let recordingPeak = null;

		/** Constraints for the next getUserMedia call. */
		function audioConstraints() {
			const id = readDeviceId();
			// "exact" is deliberate: a pinned device must never silently degrade to
			// the browser default — that degradation IS the failure this setting
			// exists to fix. A device that disappeared raises OverconstrainedError,
			// which startRecordingInner answers with a notice and a fall-back.
			return id ? { audio: { deviceId: { exact: id } } } : { audio: true };
		}

		/** Refresh the cached audioinput list (best-effort, never throws). */
		async function refreshAudioInputs() {
			try {
				const md = navigator.mediaDevices;
				if (!md || typeof md.enumerateDevices !== "function") return audioInputs;
				const all = await md.enumerateDevices();
				audioInputs = (Array.isArray(all) ? all : []).filter((d) => d && d.kind === "audioinput");
			} catch { /* the device list is UI decoration — never fatal */ }
			return audioInputs;
		}

		/** Remember the track we actually got. Returns its label ("" when unknown). */
		function describeStream(mediaStream) {
			try {
				const tracks = mediaStream && mediaStream.getAudioTracks ? mediaStream.getAudioTracks() : null;
				const track = tracks && tracks.length ? tracks[0] : null;
				if (!track) { activeDeviceLabel = ""; return ""; }
				let label = typeof track.label === "string" ? track.label : "";
				if (!label && typeof track.getSettings === "function") {
					const settings = track.getSettings();
					const id = settings && settings.deviceId;
					for (let i = 0; i < audioInputs.length; i++) {
						if (audioInputs[i].deviceId === id) { label = audioInputs[i].label || ""; break; }
					}
				}
				activeDeviceLabel = label;
				return label;
			} catch {
				activeDeviceLabel = "";
				return "";
			}
		}

		/** Short form of a device label for the narrow status pill. */
		function shortDeviceLabel(label) {
			const s = typeof label === "string" ? label.trim() : "";
			if (s.length <= 22) return s;
			return s.slice(0, 21) + "…";
		}

		/**
		 * Hint appended to an empty transcript: "we captured silence" and "the
		 * recogniser missed the speech" need opposite fixes, and the level meter
		 * already knows which one happened.
		 * @param {number|null} peak - peak |sample| of the take, null when unknown.
		 */
		function silenceHint(peak) {
			if (typeof peak !== "number") return "";
			return peak < SILENT_PEAK_THRESHOLD
				? "，输入电平≈0（可能是设备选错、麦克风被静音，或被其他程序占用）"
				: "";
		}
		//#endregion

		//#region composer DOM helpers + draft channel
		/**
		 * DraftChannel: where the transcript goes.
		 *  - Preferred: the composer slot's inputActions.setDraft (injected by
		 *    the MicrophoneButton slot — realtime, cursor-aware, no DOM query).
		 *  - Fallback: direct textarea manipulation (hotkey path when the slot
		 *    has not mounted yet, or older DSH shells without the slot).
		 * The recorder code only talks to setDraftText(text) / draftText() —
		 * it never cares which backend is live.
		 */
		let draftChannel = null; // { setDraft(text), getDraft() } from the slot

		/** Called by the MicrophoneButton slot when it mounts. */
		function setDraftChannel(channel) {
			draftChannel = channel;
		}

		function draftText() {
			if (draftChannel && typeof draftChannel.getDraft === "function") {
				try { return draftChannel.getDraft(); } catch { /* fall through */ }
			}
			const editor = findComposerEditor();
			return editor ? readEditorText(editor) : "";
		}

		/** Write the full next draft (slot setDraft preferred, DOM editor fallback). */
		function setDraftText(text) {
			if (draftChannel && typeof draftChannel.setDraft === "function") {
				try { draftChannel.setDraft(text); return true; } catch { /* fall through */ }
			}
			const editor = findComposerEditor();
			if (!editor) return false;
			return writeEditorText(editor, text);
		}

		/**
		 * Find the composer editor. DSH up to 0.1.1 rendered a <textarea>;
		 * 0.1.2 replaced it with a Lexical contenteditable div inside the same
		 * [data-composer-card] container — both shapes are supported here.
		 * CSS class names are hashed DSH classes and must never be matched.
		 */
		function findComposerEditor() {
			// Primary: the editor inside the composer card (textarea on old DSH).
			const card = document.querySelector('[data-composer-card="true"]') || document.querySelector("[data-composer-card]");
			if (card) {
				const ta = card.querySelector("textarea");
				if (ta) return ta;
				const ce = card.querySelector('[contenteditable="true"]');
				if (ce) return ce;
			}
			// Fallback: any visible textarea that is not a settings input.
			const candidates = Array.from(document.querySelectorAll("textarea"));
			const visible = candidates.filter((el) => {
				// Never grab OUR OWN settings textarea (polish prompt) — the
				// transcript must not land inside the settings page.
				if (el.closest('[data-voice-scribe-setting="1"]')) return false;
				const r = el.getBoundingClientRect();
				return r.width > 100 && r.height > 20 && el.offsetParent !== null;
			});
			// Prefer the one inside a composer-ish region.
			const composer = visible.find((el) => {
				const html = el.closest("[data-composer-card]") !== null || /composer/i.test((el.parentElement && el.parentElement.className) || "");
				return html;
			});
			return composer || visible[visible.length - 1] || null;
		}

		/** Read the editor's text (textarea value, or the contenteditable projection). */
		function readEditorText(editor) {
			if (!editor) return "";
			if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") return editor.value || "";
			// contenteditable: innerText keeps line breaks; drop the trailing
			// newline browsers add for a final empty block.
			const text = typeof editor.innerText === "string" && editor.innerText !== "" ? editor.innerText : (editor.textContent || "");
			return text.replace(/\n+$/, "");
		}

		/** Replace the editor's whole content (textarea or contenteditable). */
		function writeEditorText(editor, text) {
			if (!editor) return false;
			if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
				editor.value = text;
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				editor.focus();
				return true;
			}
			try {
				editor.focus();
				const selection = window.getSelection();
				if (selection) {
					const range = document.createRange();
					range.selectNodeContents(editor);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				// execCommand drives the editor's own beforeinput/input pipeline (Lexical
				// listens there), so the editor model stays in sync with the DOM.
				if (typeof document.execCommand === "function") {
					const done = text === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, text);
					if (done) return true;
				}
			} catch { /* fall through */ }
			try {
				editor.textContent = text;
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			} catch { return false; }
		}

		/** Insert text at the editor's cursor (textarea: setRangeText; contenteditable: insertText). */
		function insertIntoComposer(editor, text) {
			if (!editor || !text) return false;
			if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
				try {
					const before = editor.value;
					const start = editor.selectionStart != null ? editor.selectionStart : before.length;
					const end = editor.selectionEnd != null ? editor.selectionEnd : before.length;
					const sep = before.length > 0 && start > 0 && !/\s$/.test(before.slice(0, start)) ? " " : "";
					editor.setRangeText(sep + text, start, end, "end");
					editor.dispatchEvent(new Event("input", { bubbles: true }));
					editor.focus();
					return true;
				} catch { return false; }
			}
			try {
				const selection = window.getSelection();
				const caretInside = selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer);
				editor.focus();
				if (!caretInside && selection) {
					const range = document.createRange();
					range.selectNodeContents(editor);
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				const before = readEditorText(editor);
				const sep = before !== "" && !/\s$/.test(before) ? " " : "";
				if (typeof document.execCommand === "function" && document.execCommand("insertText", false, sep + text)) return true;
			} catch { /* fall through */ }
			const current = readEditorText(editor);
			return writeEditorText(editor, current === "" || /\s$/.test(current) ? current + text : current + " " + text);
		}

		//#endregion

		//#region recorder: Web Speech (browser built-in, zero config / zero key)
		/**
		 * Web Speech API (SpeechRecognition): Chrome/Edge built-in, no API key,
		 * audio handled by the browser. Start/stop maps exactly to our tap-Alt
		 * interaction. This is the default engine so the plugin works out of
		 * the box for users whose only credential is the DeepSeek API key
		 * (a text-model key cannot transcribe audio).
		 */
		const SpeechRecognitionCtor = typeof window !== "undefined"
			? (window.SpeechRecognition || window.webkitSpeechRecognition)
			: undefined;
		let recognition = null;
		let wsRecording = false;
		let wsFinalText = "";
		/** Draft snapshot when Web Speech recording began — interim results layer on top. */
		let wsDraftBase = "";
		/** Ignore events from recognizers which have already ended or timed out. */
		let wsTake = 0;

		function webSpeechSupported() {
			return typeof SpeechRecognitionCtor !== "undefined";
		}

		/**
		 * Append one recognized segment to the accumulated transcript. Chrome/Edge
		 * normally include the separating space in the segment itself, but not
		 * always — and gluing two English finals yields "helloworld". A space is
		 * added ONLY on an ASCII word boundary, so CJK output (where an inserted
		 * space would be wrong) is never touched either way.
		 */
		function appendSpeechSegment(accumulated, segment) {
			if (accumulated === "" || segment === "") return accumulated + segment;
			const boundary = /[0-9A-Za-z]$/.test(accumulated) && /^[0-9A-Za-z]/.test(segment);
			return accumulated + (boundary ? " " : "") + segment;
		}

		function startWebSpeech() {
			if (wsRecording || recording || startPending || busy) return false;
			if (!webSpeechSupported()) {
				setStatus("此浏览器不支持 Web Speech 识别（请用 Chrome/Edge）");
				return false;
			}
			try {
				recognition = new SpeechRecognitionCtor();
				const take = ++wsTake;
				// Baseline for realtime interim transcription: everything the
				// recognizer produces is layered ON TOP of the draft as it was
				// when recording began (never clobber the user's existing draft).
			wsDraftBase = draftText();
			resetPreviewState();
				recognition.continuous = true;
				// interimResults must be ON: with continuous=true, Chrome/Edge only
				// emit final results after a silence pause. If the user taps Alt to
				// stop mid-sentence, stop() drops the un-finalized speech and we'd
				// get an empty transcript. With interim on, onresult keeps the
				// latest hypothesis so we can fall back to it on stop.
				recognition.interimResults = true;
				// "自动" must follow the browser language — hard-coding zh-CN here
				// made every English browser produce Chinese results.
				recognition.lang = readLanguage() || (typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh-CN");
				wsFinalText = "";
				wsLastInterim = "";
				pendingWsStop = false;
				wsError = null;
				discardWsOnEnd = false;
				recognition.onresult = (event) => {
					if (take !== wsTake || !wsRecording) return;
					// The result list contains the complete session. Rebuild both parts:
					// a final sentence and its unfinished tail must survive together.
					wsFinalText = "";
					wsLastInterim = "";
					for (let i = 0; i < event.results.length; i++) {
						const result = event.results[i];
						if (result.isFinal) {
							wsFinalText = appendSpeechSegment(wsFinalText, result[0].transcript);
						} else {
							// Keep the latest interim hypothesis so a mid-sentence
							// stop() can still recover what was spoken.
							wsLastInterim = appendSpeechSegment(wsLastInterim, result[0].transcript);
						}
					}
					// Realtime: stream the latest hypothesis into the composer
					// while the user is still talking (interim is transient —
					// the final transcript replaces it on stop).
					const hypothesis = appendSpeechSegment(wsFinalText, wsLastInterim);
					if (hypothesis) {
						const sep = wsDraftBase && !/\s$/.test(wsDraftBase) ? " " : "";
						writePreviewSpan(wsDraftBase + sep + hypothesis);
					}
				};
				recognition.onerror = (event) => {
					if (take !== wsTake || !wsRecording) return;
					// Record the failure so onend does not overwrite it with a
					// generic "no text" message. "aborted" is our own stop().
					if (event.error === "aborted") return;
					wsError = event.error || "unknown";
					if (event.error === "not-allowed" || event.error === "service-not-allowed") {
						setStatus("❌ 麦克风权限被拒绝（请在浏览器地址栏授予麦克风权限）", true);
					} else if (event.error === "no-speech") {
						setStatus("未检测到语音", true);
					} else if (event.error === "network") {
						// The browser's speech backend (Google/Microsoft) is
						// unreachable — common on mainland-China networks and on
						// Edge Stable (known regression). In "auto" mode, switch
						// to the local SenseVoice engine (zero key, offline).
						if (readEngine() === "auto") {
							void autoFallbackToLocal();
						} else {
							setStatus("❌ 浏览器语音识别不可用：识别服务需访问 Google/微软，当前网络无法连接。请到 设置 → 语音输入 切换「本地离线识别」或「云端 ASR」", true);
						}
					} else {
						setStatus("❌ 识别错误：" + event.error, true);
					}
				};
				recognition.onend = () => {
					if (take !== wsTake) return;
					wsTake++;
					// onend fires after every onresult has been delivered — this is
					// the ONLY safe point to read the final transcript. Reading it
					// right after recognition.stop() races the last results.
					if (wsStopWatchdog !== null) { clearTimeout(wsStopWatchdog); wsStopWatchdog = null; }
					const wasRecording = wsRecording;
					wsRecording = false;
					syncMicState();
					recognition = null;
					if (discardWsOnEnd) {
						// The window lost focus mid-recording (Alt+Tab …) — cancel
						// instead of inserting text the user did not intend for
						// the composer.
						discardWsOnEnd = false;
						rollbackPreview(wsDraftBase);
						setStatus("已取消");
						return;
					}
					if (wsError !== null) {
						// A real failure already surfaced the cause — do not replace
						// it with finishWebSpeech's "未识别到文字". Any interim
						// hypothesis streamed into the composer must go away, or a
						// truncated sentence stays there looking final.
						wsError = null;
						rollbackPreview(wsDraftBase);
						return;
					}
					if (wasRecording) {
						finishWebSpeech();
					} else if (!pendingWsStop) {
						// Unexpected end (silence timeout etc.) — surface it.
						setStatus("录音已结束（未检测到持续语音）", true);
					}
				};
				recognition.start();
				// Web Speech captures through the browser, so the level meter never runs
				// for it: the peak has to go back to "unknown" here, otherwise a previous
				// silent take would be reported as THIS take's silence.
				recordingPeak = null;
				wsRecording = true;
				syncMicState();
				// Push-to-talk released before the (synchronous) start landed.
				if (holdStopPending) {
					holdStopPending = false;
					stopWebSpeech();
					return true;
				}
				setStatus("🎙 录音中…（" + (readMode() === "hold" ? "松开结束" : "再按一次结束") + "）", true);
				return true;
			} catch (error) {
				wsTake++;
				recognition = null;
				wsRecording = false;
				syncMicState();
				setStatus("❌ 启动识别失败：" + (error && error.message ? error.message : "未知错误"));
				return false;
			}
		}

		/** Set when the user tapped Alt to stop; onend consumes it. */
		let pendingWsStop = false;
		/** Non-null when the last recognition ended with an error (onend must not overwrite it). */
		let wsError = null;
		/** Latest interim hypothesis — fallback when stop() drops un-finalized speech. */
		let wsLastInterim = "";
		/**
		 * Stop watchdog. SpeechRecognition.onend is not guaranteed to fire after
		 * stop() (a long-standing Chromium-family flake); without this the pill sat
		 * on "处理中…" forever, wsRecording stayed true, and every later Alt tap
		 * re-entered the same dead stop() until the page was reloaded.
		 */
		let wsStopWatchdog = null;

		/** Read the final transcript, run optional polish, insert into composer. */
		function finishWebSpeech() {
			const lifecycle = clientLifecycle;
			busy = true;
			setStatus("⏳ 转写中…", true);
			// Keep finalized speech and its unfinished tail when stopped mid-sentence.
			const text = appendSpeechSegment(wsFinalText, wsLastInterim).trim();
			if (!text) {
				// Nothing recognised: roll back the realtime interim so the
				// composer is exactly as it was before recording.
				busy = false;
				rollbackPreview(wsDraftBase);
				setStatus("未识别到文字（请靠近麦克风再说一次）" + silenceHint(recordingPeak), true);
				return;
			}
			// Optional polish through DSH's configured model.
			const polishEnabled = readPolishEnabled();
			const polishModel = readPolishModel();
			const insert = (finalText) => {
				if (lifecycle !== clientLifecycle) return;
				busy = false;
				// The interim already wrote baseline+hypothesis into the composer:
				// commitTranscript rebuilds that span from the baseline when the
				// composer still holds it, and appends to whatever the user has now
				// when they edited (or sent) the draft while dictating.
				if (commitTranscript(wsDraftBase, finalText)) setStatus("✅ 已插入");
				else setStatus("❌ 未找到输入框", true);
			};
			if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
				// Persistent: polishing can take up to 30 s — a transient pill
				// fading after 2.6 s made it look like nothing was happening.
				setStatus("✨ 润色中…", true);
				// polish() never rejects, but keep a defensive catch so a bug can
				// never leave the status pill stuck or drop the transcript.
				void polish(text, polishModel.provider, polishModel.model).then(insert).catch(() => insert(text));
			} else {
				insert(text);
			}
		}

		function stopWebSpeech() {
			if (!wsRecording || !recognition) return;
			if (pendingWsStop) return;
			// Immediate feedback: the user tapped Alt again — show processing
			// right away instead of letting the status pill sit on "录音中".
			if (wsError === null) setStatus("⏳ 处理中…", true);
			pendingWsStop = true;
			const stoppedRecognition = recognition;
			const finishRecognition = stoppedRecognition.onend;
			// Arm the watchdog before stop(): if onend never arrives the user must not
			// be stuck. It stays quiet on the normal path — onend clears it first, and a
			// late events are ignored after this take is retired by the shared end path.
			if (wsStopWatchdog !== null) clearTimeout(wsStopWatchdog);
			wsStopWatchdog = setTimeout(() => {
				wsStopWatchdog = null;
				if (!wsRecording) return;
				finishRecognition();
				try { stoppedRecognition.abort(); } catch { /* already ended */ }
			}, WS_STOP_WATCHDOG_MS);
			try {
				recognition.stop();
			} catch {
				// already stopped — finish anyway
				if (wsStopWatchdog !== null) { clearTimeout(wsStopWatchdog); wsStopWatchdog = null; }
				finishRecognition();
				try { stoppedRecognition.abort(); } catch { /* already ended */ }
			}
		}
		//#endregion

		//#region recorder (MediaRecorder, cloud-asr engine)
		let recorder = null;
		/** Set when the window blurred while getUserMedia was still pending. */
		let cancelPendingStart = false;
		let recordingChunks = [];
		let recordingMimeType = "";
		let stream = null;
		let recording = false;
		/** The engine belongs to the take, even if settings change while speaking. */
		let recordingEngine = "cloud-asr";
		let recordingStopping = false;
		/** Disposal invalidates asynchronous completions which still own old drafts. */
		let clientLifecycle = 0;
		/** True while a transcript is being finished/polished (mic button "busy"). */
		let busy = false;
		/** Auto-stop timer for the per-engine recording-length cap. */
		let recordingCapTimer = null;
		/** Set when the window lost focus while a TAP-mode recording was live —
		 *  the pending stop must DISCARD (roll back, no insert) instead of
		 *  transcribing. Alt+Tab must not leave the mic hot or dump text into
		 *  the composer. */
		let discardWsOnEnd = false;
		let discardOnStop = false;
		/** Draft snapshot when MediaRecorder recording began (realtime preview base). */
		let recDraftBase = "";
		/** Realtime preview timer for the LOCAL engine (3s cadence). */
		let localPreviewTimer = null;
		/**
		 * Synchronous in-flight guard. `recording` only flips true AFTER
		 * getUserMedia resolves, and the permission prompt can sit open for
		 * seconds — far longer than the hotkey debounce. Without this, a second
		 * Alt tap starts a second stream + recorder: the first stream's tracks
		 * are never stopped (microphone stays live) and both recorders push into
		 * the same chunk array, producing a garbled blob.
		 */
		let startPending = false;

		async function startRecording() {
			if (recording || startPending) return false;
			if (wsRecording || busy) return false;
			recordingEngine = effectiveEngine();
			startPending = true;
			try {
				return await startRecordingInner();
			} finally {
				startPending = false;
			}
		}

		async function startRecordingInner() {
			const lifecycle = clientLifecycle;
			if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				setStatus("此浏览器不支持麦克风（需要 HTTPS 或 localhost）");
				return false;
			}
			cancelPendingStart = false;
			// The pinned device makes the choice explicit (see audioConstraints):
			// relying on the browser's own resolution is how a silent virtual
			// microphone ends up recording while everything looks fine.
			const pinnedDevice = readDeviceId();
			let deviceNotice = "";
			try {
				stream = await navigator.mediaDevices.getUserMedia(audioConstraints());
			} catch (error) {
				if (cancelPendingStart || lifecycle !== clientLifecycle) {
					if (lifecycle === clientLifecycle) setStatus("已取消");
					return false;
				}
				const errorName = error && error.name ? error.name : "";
				// A pinned device can disappear (unplugged, disabled in the OS, site
				// data cleared): say so and fall back instead of dead-ending the user
				// on a bare "OverconstrainedError".
				if (pinnedDevice && (errorName === "OverconstrainedError" || errorName === "NotFoundError")) {
					writeDeviceId("");
					void refreshAudioInputs();
					try {
						stream = await navigator.mediaDevices.getUserMedia({ audio: true });
						deviceNotice = "⚠️ 之前选择的麦克风已不可用，已回退到系统默认设备 · ";
					} catch (fallbackError) {
						if (cancelPendingStart || lifecycle !== clientLifecycle) return false;
						setStatus("无法访问麦克风：" + (fallbackError && fallbackError.name ? fallbackError.name : "权限被拒绝"));
						return false;
					}
				} else {
					setStatus("无法访问麦克风：" + (errorName || "权限被拒绝"));
					return false;
				}
			}
			if (cancelPendingStart || lifecycle !== clientLifecycle) {
				// The window blurred while the permission prompt was up: release the
				// microphone instead of recording into the background.
				cancelPendingStart = false;
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
				if (lifecycle === clientLifecycle) setStatus("已取消");
				return false;
			}
			// What the browser actually handed us. The label only exists once the
			// microphone was granted — which is exactly now.
			const liveDeviceLabel = describeStream(stream);
			recordingChunks = [];
			discardOnStop = false;
			recordingStopping = false;
			// Baseline for realtime preview (local engine): recorded text layers
			// on top of the draft as it was when recording began.
			recDraftBase = draftText();
			resetPreviewState();
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			const preferred = ["audio/webm", "audio/mp4", "audio/ogg"];
			const mime = preferred.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
			recordingMimeType = mime || "audio/webm";
			try {
				recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
				recordingMimeType = recorder.mimeType || recordingMimeType;
			} catch (error) {
				// MediaRecorder construction failed (unsupported mime / platform).
				// Release the microphone — otherwise the stream stays live and
				// the mic indicator never turns off.
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
				stopLevelMeter();
				setStatus("❌ 无法启动录音：" + (error && error.message ? error.message : "MediaRecorder 不可用"), true);
				return false;
			}
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) recordingChunks.push(event.data);
			};
			recorder.onstop = () => {
				const blob = new Blob(recordingChunks, { type: recordingMimeType });
				void finishRecording(blob);
			};
			// A timeslice is REQUIRED for ondataavailable to fire during the
			// recording: without it the chunk array stayed empty until stop(), so
			// every 3 s preview built an empty blob and silently did nothing.
			// start() throws when the stream died between getUserMedia and here
			// (device unplugged / grabbed by another app) — unguarded, that left the
			// stream live with no recorder, so no onstop would ever release it and the
			// next Alt tap opened a SECOND stream on top of the leaked one.
			try {
				recorder.start(1000);
			} catch (error) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
				recorder = null;
				stopLevelMeter();
				setStatus("❌ 无法开始录音：" + (error && error.message ? error.message : "麦克风已停止"), true);
				return false;
			}
			recording = true;
			syncMicState();
			// Hard cap: the local engine ships RAW PCM (see LOCAL_MAX_RECORDING_MS) —
			// a longer take would blow past the host's body limit and fail with 413.
			const capMs = recordingEngine === "local" ? LOCAL_MAX_RECORDING_MS : CLOUD_MAX_RECORDING_MS;
			recordingCapTimer = setTimeout(() => {
				recordingCapTimer = null;
				if (!recording) return;
				setStatus("⏱ 已达最长录音时长，自动转写…", true);
				stopRecording();
			}, capMs);
			// Live input level (cosmetic): bars under the status pill while
			// recording. Never fatal — startLevelMeter catches internally.
			recordingPeak = null;
			startLevelMeter(stream);
			// Push-to-talk: the user may release before getUserMedia resolved —
			// stop immediately instead of recording with nobody to stop it.
			if (holdStopPending) {
				holdStopPending = false;
				stopRecording();
				return true;
			}
			// Realtime preview (local engine only): every 3s, transcribe what
			// has been recorded so far and stream the hypothesis into the
			// composer. Cloud/web-speech engines skip this (cost / redundancy).
			if (recordingEngine === "local" && !localPreviewTimer) {
				localPreviewTimer = setInterval(() => { void runLocalPreview(); }, 3000);
			}
			setStatus(deviceNotice + "🎙 录音中…（" + (readMode() === "hold" ? "松开结束" : "再按一次结束") + "）"
				+ (liveDeviceLabel ? " · " + shortDeviceLabel(liveDeviceLabel) : ""), true);
			return true;
		}

		async function finishRecording(blob) {
			const lifecycle = clientLifecycle;
			recording = false;
			recordingStopping = false;
			recorder = null;
			syncMicState();
			if (recordingCapTimer) { clearTimeout(recordingCapTimer); recordingCapTimer = null; }
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			stopLevelMeter();
			if (stream) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
			}
			if (discardOnStop) {
				// Window lost focus mid-recording (Alt+Tab …) — cancel: roll
				// back any preview and never insert text the user did not
				// intend for the composer.
				discardOnStop = false;
				busy = false;
				rollbackPreview(recDraftBase);
				setStatus("已取消");
				return;
			}
			if (blob.size < 200) {
				busy = false;
				// Too short: roll back the realtime preview so stale text does
				// not stay in the composer as if it were final. Only the local
				// engine writes a preview — rolling back unconditionally would
				// throw away anything the user typed while recording.
				rollbackPreview(recDraftBase);
				setStatus("录音太短，未转写");
				return;
			}
			busy = true;
			setStatus("⏳ 转写中…", true);
			try {
				let result;
				if (recordingEngine === "local") {
					setStatus("⏳ 本地离线转写中…", true);
					result = await transcribeLocal(blob);
				} else {
					const reader = new FileReader();
					const base64 = await new Promise((resolve, reject) => {
						reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
					if (lifecycle !== clientLifecycle) return;
					const language = readLanguage();
					result = await transcribe(base64, blob.type || recordingMimeType, language);
				}
				if (lifecycle !== clientLifecycle) return;
				if (!result.ok) {
					busy = false;
					rollbackPreview(recDraftBase);
					setStatus("❌ 转写失败：" + (result.error || "请检查设置中的 ASR 配置"), true);
					return;
				}
				// The LOCAL route answers ok:true with text:"" for silence (SenseVoice
				// returns an empty string rather than an error), and committing that said
				// "✅ 已插入" while inserting nothing — plus a stray trailing space. The
				// cloud route reports asr-empty and Web Speech has its own branch, so this
				// made the same silence an engine-dependent surprise.
				if (typeof result.text !== "string" || result.text.trim() === "") {
					busy = false;
					rollbackPreview(recDraftBase);
					setStatus("未识别到文字（请靠近麦克风再说一次）" + silenceHint(recordingPeak), true);
					return;
				}
				let text = result.text;
				// Optional polish through DSH's configured model.
				const polishEnabled = readPolishEnabled();
				const polishModel = readPolishModel();
				if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
					setStatus("✨ 润色中…", true);
					text = await polish(text, polishModel.provider, polishModel.model);
				}
				if (lifecycle !== clientLifecycle) return;
				// The realtime preview already wrote baseline+hypothesis into the
				// composer: commitTranscript replaces that span from the baseline when
				// the composer still holds it, and appends to whatever the user has
				// now when they edited (or sent) the draft while recording.
				if (commitTranscript(recDraftBase, text)) setStatus("✅ 已插入");
				else setStatus("❌ 未找到输入框");
				busy = false;
			} catch (error) {
				if (lifecycle !== clientLifecycle) return;
				busy = false;
				rollbackPreview(recDraftBase);
				setStatus("❌ 转写失败：" + (error && error.message ? error.message : "未知错误"));
			}
		}

		function stopRecording() {
			if (!recording || !recorder || recordingStopping) return;
			recordingStopping = true;
			busy = true;
			if (recordingCapTimer) { clearTimeout(recordingCapTimer); recordingCapTimer = null; }
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			try {
				recorder.stop();
			} catch {
				recording = false;
				recordingStopping = false;
				busy = false;
				recorder = null;
				syncMicState();
				stopLevelMeter();
				if (stream) {
					stream.getTracks().forEach((track) => track.stop());
					stream = null;
				}
				setStatus("已停止");
			}
		}

		//#region recording level meter (Web Audio analyser — cosmetic, never fatal)
		let levelCtx = null;
		let levelAnalyser = null;
		let levelData = null;
		let levelTimer = null;
		let levelEl = null;
		let levelBars = null;
		let levelTimeData = null;

		/** The small 5-bar level indicator (fixed pill under the status pill). */
		function ensureLevelEl() {
			if (levelEl && document.body.contains(levelEl)) return levelEl;
			levelEl = document.createElement("div");
			levelEl.id = "dsh-voice-input-level";
			levelEl.setAttribute("aria-hidden", "true");
			levelEl.style.cssText = [
				"position:fixed",
				"left:50%",
				"top:56px",
				"transform:translateX(-50%)",
				"z-index:99999",
				"display:flex",
				"align-items:flex-end",
				"gap:3px",
				"height:26px",
				"padding:4px 8px",
				"background:rgba(20,20,26,0.92)",
				"border:1px solid rgba(255,255,255,0.14)",
				"border-radius:999px",
				"box-shadow:0 4px 24px rgba(0,0,0,0.35)",
				"pointer-events:none"
			].join(";");
			levelBars = [];
			for (let i = 0; i < 5; i++) {
				const bar = document.createElement("span");
				bar.style.cssText = "display:block;width:4px;height:4px;border-radius:2px;background:#e5484d;transition:height .08s linear";
				levelEl.appendChild(bar);
				levelBars.push(bar);
			}
			document.body.appendChild(levelEl);
			return levelEl;
		}

		/** Sample the analyser and resize the bars (each bar = one slice of the
		 *  lower 2/3 of the spectrum, where voice energy lives). */
		function updateLevelMeter() {
			if (!levelAnalyser || !levelData || !levelEl || !levelBars) return;
			try {
				levelAnalyser.getByteFrequencyData(levelData);
				// Absolute peak (time domain): the bars are relative and smoothed, but
				// "was there ANY sound at all" needs a real number — it is what tells a
				// silent capture apart from a recogniser miss in the empty-transcript hint.
				if (levelTimeData && typeof levelAnalyser.getFloatTimeDomainData === "function") {
					levelAnalyser.getFloatTimeDomainData(levelTimeData);
					for (let i = 0; i < levelTimeData.length; i++) {
						const abs = levelTimeData[i] < 0 ? -levelTimeData[i] : levelTimeData[i];
						if (abs > recordingPeak) recordingPeak = abs;
					}
				}
				const bins = levelData.length;
				for (let i = 0; i < levelBars.length; i++) {
					const start = Math.floor((i / levelBars.length) * bins * 0.66);
					const end = Math.max(start + 1, Math.floor(((i + 1) / levelBars.length) * bins * 0.66));
					let sum = 0;
					for (let j = start; j < end; j++) sum += levelData[j];
					const v = sum / (end - start) / 255;
					const h = 4 + Math.round(Math.min(1, v * 1.8) * 18);
					levelBars[i].style.height = h + "px";
				}
			} catch { /* meter is decoration — keep recording alive */ }
		}

		/** Attach an analyser to the recording stream (best-effort). */
		function startLevelMeter(mediaStream) {
			if (!mediaStream) return;
			try {
				const Ctx = window.AudioContext || window.webkitAudioContext;
				if (!Ctx) return;
				levelCtx = new Ctx();
				const source = levelCtx.createMediaStreamSource(mediaStream);
				levelAnalyser = levelCtx.createAnalyser();
				levelAnalyser.fftSize = 256;
				levelAnalyser.smoothingTimeConstant = 0.7;
				source.connect(levelAnalyser);
				levelData = new Uint8Array(levelAnalyser.frequencyBinCount);
				levelTimeData = typeof levelAnalyser.getFloatTimeDomainData === "function"
					? new Float32Array(levelAnalyser.fftSize)
					: null;
				recordingPeak = 0;
				ensureLevelEl();
				levelTimer = setInterval(updateLevelMeter, 100);
			} catch {
				// The meter is decoration — a failure here must never break recording.
				stopLevelMeter();
			}
		}

		/** Tear the meter down (timer, DOM, audio graph). Safe to call twice. */
		function stopLevelMeter() {
			if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
			if (levelEl) { levelEl.remove(); levelEl = null; }
			levelBars = null;
			levelAnalyser = null;
			levelData = null;
			levelTimeData = null;
			// recordingPeak deliberately survives: the empty-transcript hint is
			// rendered after the meter was torn down.
			if (levelCtx) {
				try { void levelCtx.close(); } catch { /* already closed */ }
				levelCtx = null;
			}
		}
		//#endregion

		//#region local engine (SenseVoice via host sherpa-onnx — zero key, offline)

		/** Decode a recording blob to 16 kHz mono float32 PCM (browser-side). */
		function blobToPcm16k(blob) {
			return new Promise(async (resolve, reject) => {
				// Hard timeout so a stuck decode can never leave the status pill
				// on "本地离线转写中…" forever.
				// The timeout has to close the context itself: the finally below only
				// runs once the awaited decode settles, and the whole point of this timer
				// is the Edge case where decodeAudioData NEVER calls back — one leaked
				// context per 3 s preview, until the browser's ~6-context budget is gone
				// and both the local engine and the level meter break until a reload.
				let ctx = null;
				const timer = setTimeout(() => {
					if (ctx) { try { ctx.close().catch(() => {}); } catch { /* already closed */ } }
					reject(new Error("音频解码超时（请重试，或缩短录音）"));
				}, 30000);
				try {
					const Ctx = window.AudioContext || window.webkitAudioContext;
					if (!Ctx) { reject(new Error("此浏览器不支持音频解码")); return; }
					ctx = new Ctx();
					// decodeAudioData takes an ArrayBuffer — passing a Blob is
					// non-standard and can silently never call back in Edge.
					const arrayBuffer = await blob.arrayBuffer();
					const buffer = await ctx.decodeAudioData(arrayBuffer);
					const src = buffer.getChannelData(0);
					const targetRate = 16000;
					let out;
					if (buffer.sampleRate === targetRate) {
						out = new Float32Array(src);
					} else {
						const ratio = buffer.sampleRate / targetRate;
						out = new Float32Array(Math.round(src.length / ratio));
						for (let i = 0; i < out.length; i++) {
							const pos = i * ratio;
							const i0 = Math.floor(pos);
							const i1 = Math.min(i0 + 1, src.length - 1);
							const frac = pos - i0;
							out[i] = src[i0] + (src[i1] - src[i0]) * frac;
						}
					}
					resolve(out);
				} catch (error) {
					reject(error);
				} finally {
					// The failure and timeout paths used to leave the AudioContext open;
					// repeated failed decodes then exhausted the browser's context budget
					// and broke the local engine AND the level meter until a reload.
					clearTimeout(timer);
					if (ctx) ctx.close().catch(() => {});
				}
			});
		}

		/** Float32Array -> little-endian base64 (bytes), for the host route. */
		function f32ToBase64(samples) {
			const bytes = new Uint8Array(samples.length * 4);
			const view = new DataView(bytes.buffer);
			for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
			}
			return btoa(binary);
		}

		/** Query the host for local-model status and cache the readiness flag. */
		async function refreshLocalStatus() {
			try {
				const data = await hostCall({ action: "local-status" });
				if (data && data.ok === true && data.value) {
					localReady = data.value.modelReady === true;
					return data.value;
				}
			} catch {
				// host unreachable — keep last known state
			}
			return null;
		}

		/** In-flight ensure promise: a second Alt tap while the model is still
		 *  downloading must join the ongoing poll, not start a duplicate loop
		 *  (an earlier flag was written but never read — it guarded nothing). */
		let localModelPromise = null;

		/** Start the model download and poll until ready (or give up). */
		async function ensureLocalModel() {
			if (localModelPromise) return localModelPromise;
			localModelPromise = ensureLocalModelInner();
			try {
				return await localModelPromise;
			} finally {
				localModelPromise = null;
			}
		}

		async function ensureLocalModelInner() {
			try {
				const start = await hostCall({ action: "local-download" });
				if (!start || start.ok !== true) {
					return false;
				}
				for (let i = 0; i < 200; i++) {
					await new Promise((r) => setTimeout(r, 3000));
					const status = await refreshLocalStatus();
					if (status && status.modelReady) return true;
					if (status && status.error) {
						setStatus("❌ 本地识别模型下载失败：" + (status.error || "请检查网络"), true);
						return false;
					}
				}
			} finally {
				// nothing to release here: ensureLocalModel owns localModelPromise
			}
			setStatus("❌ 本地识别模型下载超时，请稍后重试", true);
			return false;
		}

		/** Transcribe a recording blob with the LOCAL engine. */
		async function transcribeLocal(blob) {
			const lifecycle = clientLifecycle;
			try {
				const samples = await blobToPcm16k(blob);
				if (lifecycle !== clientLifecycle) return { ok: false, error: "已取消" };
				if (samples.length === 0) return { ok: false, error: "未解码到有效音频（请重试）" };
				const audio = f32ToBase64(samples);
				const data = await hostCall({ action: "local-transcribe", audio, sampleRate: 16000 }, LOCAL_TRANSCRIBE_TIMEOUT_MS);
				if (data && data.ok === true && typeof data.text === "string") return { ok: true, text: data.text };
				const msg = data && data.error && typeof data.error.message === "string" ? data.error.message : "本地转写失败";
				return { ok: false, error: msg };
			} catch (error) {
				return { ok: false, error: error && error.message ? error.message : "本地转写失败" };
			}
		}

		/** In-flight guard: a slow preview must not stack another request. */
		let localPreviewRunning = false;
		/** Chunks already transcribed by the last preview (tail-only upload). */
		let previewChunkIndex = 0;
		/** Text accumulated from the preview segments (appended to the baseline). */
		let previewText = "";
		/**
		 * The exact composer text this plugin last wrote as a realtime preview
		 * (null when no preview is live). Commit and rollback compare against it, so
		 * a draft the user edited mid-recording is never overwritten — and text they
		 * already sent (Enter clears the composer) is never resurrected.
		 */
		let previewSpanText = null;
		let previewBaseline = "";

		/**
		 * The last few drafts this plugin itself handed to the composer, newest
		 * first. A live draft one render behind is normal (setDraft → store →
		 * React updates inputActions' consumer), so a value we just wrote must still
		 * count as ours — anything else in the composer belongs to the user.
		 */
		let previewWritten = [];

		/**
		 * Write a realtime preview span and remember it for commit/rollback.
		 * The composer belongs to the plugin ONLY while it still holds something the
		 * plugin itself wrote: as soon as the user types, pastes or sends while
		 * dictating, the next interim/preview would otherwise replace their words
		 * wholesale — and commitTranscript would then see "the composer holds our
		 * span" and rebuild from the baseline, so the typed text could never come
		 * back. Stop previewing instead; the final transcript is still appended to
		 * whatever the user has (see commitTranscript).
		 */
		function writePreviewSpan(text) {
			// The user can type/send before the recognizer's first result arrives.
			if (previewSpanText === null && draftText() !== previewBaseline) return false;
			if (previewSpanText !== null) {
				const current = draftText();
				if (current !== previewSpanText && previewWritten.indexOf(current) === -1) return false;
			}
			previewSpanText = text;
			previewWritten = [text, previewWritten[0]].filter((v) => v !== undefined);
			return setDraftText(text);
		}

		/**
		 * Identifies the take a preview belongs to. Stopping and immediately
		 * starting again is allowed (nothing blocks it), so a preview still in
		 * flight from the previous take could otherwise write the OLD hypothesis
		 * into the new session and advance the chunk cursor from a stale count.
		 */
		let previewTake = 0;

		/** Reset the preview bookkeeping for a fresh recording. */
		function resetPreviewState() {
			previewChunkIndex = 0;
			previewText = "";
			previewSpanText = null;
			previewBaseline = draftText();
			previewWritten = [];
			previewTake++;
		}

		/**
		 * Commit a final transcript. Rebuilds from the pre-recording baseline only
		 * when the composer still holds exactly our preview span; otherwise the user
		 * changed (or sent) the draft while recording, so the transcript is appended
		 * to what is there now instead of clobbering their words.
		 */
		function commitTranscript(baseline, finalText) {
			const sep = (s) => (s !== "" && !/\s$/.test(s) ? " " : "");
			const current = draftText();
			const rebuild = previewSpanText !== null && current === previewSpanText;
			previewSpanText = null;
			return setDraftText(rebuild ? baseline + sep(baseline) + finalText : current + sep(current) + finalText);
		}

		/** Drop the live preview span, restoring the baseline only if untouched. */
		function rollbackPreview(baseline) {
			if (previewSpanText !== null && draftText() === previewSpanText) setDraftText(baseline);
			previewSpanText = null;
		}

		/**
		 * Realtime preview for the LOCAL engine: transcribe what has been
		 * recorded so far and stream the hypothesis into the composer. Runs on
		 * a 3s cadence while recording; errors are silent (the final
		 * transcription on stop is authoritative).
		 */
		async function runLocalPreview() {
			if (!recording || !recorder || localPreviewRunning) return;
			localPreviewRunning = true;
			try {
				// Upload the container header (chunk 0) plus only the chunks the last
				// preview has not seen yet: re-sending the whole recording every 3 s
				// grew quadratically (up to ~16 MB per request at the 4.3 min cap).
				const first = recordingChunks.length > 0 ? recordingChunks[0] : null;
				const tail = recordingChunks.slice(previewChunkIndex);
				if (first === null || tail.length === 0) return;
				const blob = new Blob(previewChunkIndex === 0 ? recordingChunks.slice() : [first, ...tail], { type: recordingMimeType });
				if (blob.size < 200) return;
				// Snapshot how far the uploaded blob reaches BEFORE awaiting: ondataavailable
				// keeps firing during the request, and advancing to the CURRENT chunk count
				// afterwards marked that in-flight audio as already transcribed — the preview
				// then silently skipped 1-3 s of speech on every cycle.
				const sentThrough = previewChunkIndex + tail.length;
				const take = previewTake;
				const result = await transcribeLocal(blob);
				if (take !== previewTake) return; // a new take owns the composer now
				if (!recording || !result.ok || !result.text) return;
				previewChunkIndex = sentThrough;
				previewText = previewText === "" ? result.text : previewText + " " + result.text;
				// Layer the accumulated hypothesis on top of the draft baseline
				// (never clobber the user's existing draft).
				const sep = recDraftBase && !/\s$/.test(recDraftBase) ? " " : "";
				writePreviewSpan(recDraftBase + sep + previewText);
			} catch { /* preview is best-effort */ }
			finally {
				localPreviewRunning = false;
			}
		}

		/** Start local recording: ensure the model first, then reuse MediaRecorder. */
		async function startLocalRecording() {
			if (!localReady) {
				setStatus("⏳ 首次使用需下载本地识别模型（约 230MB，只需一次）…", true);
				const ok = await ensureLocalModel();
				if (!ok) return false;
				setStatus("✅ 本地识别模型就绪，请再按一次 " + activeTriggerName() + " 开始说话", true);
				return false; // user presses again to start
			}
			return startRecording();
		}
		//#endregion

		/** Reflect recording/busy state on window so the mic button can read it. */
		function syncMicState() {
			window.__voiceScribeRecording = wsRecording || recording;
			window.__voiceScribeBusy = busy;
		}

		function toggleRecording() {
			// A stale holdStopPending (hold-mode release landed before an async
			// start finished and that start then failed) must not instantly stop
			// the next tap-mode recording.
			holdStopPending = false;
			// Stop the active capture regardless of any engine setting change.
			if (wsRecording) { stopWebSpeech(); syncMicState(); return; }
			if (recording) { stopRecording(); syncMicState(); return; }
			if (busy || startPending) return;
			const engine = effectiveEngine();
			if (engine === "web-speech") {
				void startWebSpeech();
			} else if (engine === "local") {
				void startLocalRecording();
			} else {
				void startRecording();
			}
			syncMicState();
		}
		//#endregion

		//#region status bar
		let statusEl = null;
		function ensureStatusEl() {
			if (statusEl && document.body.contains(statusEl)) return statusEl;
			statusEl = document.createElement("div");
			statusEl.id = "dsh-voice-input-status";
			statusEl.style.cssText = [
				"position:fixed",
				"left:50%",
				"top:16px",
				"transform:translateX(-50%)",
				"z-index:99999",
				"background:rgba(20,20,26,0.92)",
				"color:#f4f5f7",
				"border:1px solid rgba(255,255,255,0.14)",
				"border-radius:999px",
				"padding:6px 16px",
				"font:13px/1.5 system-ui,sans-serif",
				"box-shadow:0 4px 24px rgba(0,0,0,0.35)",
				"transition:opacity .15s",
				"pointer-events:none"
			].join(";");
			statusEl.setAttribute("role", "status");
			statusEl.setAttribute("aria-live", "polite");
			statusEl.setAttribute("aria-atomic", "true");
			document.body.appendChild(statusEl);
			return statusEl;
		}
		let statusTimer = null;
		/**
		 * Show a status pill. Persistent statuses (recording / transcribing)
		 * stay visible until a non-persistent status replaces them; transient
		 * statuses (success / error) auto-fade after STATUS_FADE_MS.
		 * @param {string} text - status text.
		 * @param {boolean} [persistent=false] - keep visible (no auto-fade).
		 */
		function setStatus(text, persistent) {
			const el = ensureStatusEl();
			el.textContent = text;
			el.style.opacity = "1";
			if (statusTimer) clearTimeout(statusTimer);
			if (!persistent) {
				statusTimer = setTimeout(() => { el.style.opacity = "0"; }, 2600);
			}
		}
		//#endregion

		//#region push-to-talk (hold mode)
		/** A hold gesture is live (key/pointer down seen, up not yet). */
		let holdActive = false;
		/** Set when the user releases BEFORE an async start has finished —
		 *  startRecording consumes it and stops immediately, so releasing
		 *  early can never leave a recording running with nobody to stop it. */
		let holdStopPending = false;

		/** Start recording for the hold gesture (engine-routed). */
		function startHold() {
			holdStopPending = false;
			const engine = effectiveEngine();
			if (engine === "web-speech") {
				startWebSpeech();
			} else if (engine === "local") {
				void startLocalRecording();
			} else {
				void startRecording();
			}
			syncMicState();
		}

		/** Release: stop whatever is actually recording. When the async start
		 *  (getUserMedia) has not landed yet, arm holdStopPending instead. */
		function stopHold() {
			if (wsRecording) stopWebSpeech();
			else if (recording) stopRecording();
			else holdStopPending = true;
			syncMicState();
		}

		/** Begin one hold gesture (keyboard or pointer). Idempotent. */
		function beginHold() {
			if (holdActive || busy || startPending || recording || wsRecording) return;
			holdActive = true;
			startHold();
		}

		/** End one hold gesture; no-op when nothing is being held. */
		function endHold() {
			if (!holdActive) return;
			holdActive = false;
			stopHold();
		}
		//#endregion

		//#region hotkey grammar
		/** Canonical tokens for modifier keys (lower-case). */
		const MODIFIER_TOKENS = ["alt", "ctrl", "shift", "meta"];
		/** Named (non-printable) tokens accepted as a trigger key in a combo. */
		const NAMED_KEY_TOKENS = ["space", "enter", "tab", "esc", "backspace", "delete", "insert",
			"home", "end", "pageup", "pagedown", "arrowup", "arrowdown", "arrowleft", "arrowright"];

		/** Map a DOM KeyboardEvent.key to the canonical combo token. */
		function normalizeKeyToken(rawKey) {
			if (rawKey === " ") return "space";
			const lower = String(rawKey).toLowerCase();
			if (lower === "control") return "ctrl";
			if (lower === "escape") return "esc";
			return lower;
		}

		/** Is a canonical token a modifier? */
		function isModifierToken(token) {
			return MODIFIER_TOKENS.indexOf(token) >= 0;
		}

		/** Is a canonical token usable as the trigger key of a combo? */
		function isValidKeyToken(token) {
			if (token.length === 1) return /^[a-z0-9]$/.test(token) || /^[\x21-\x7e]$/.test(token);
			if (NAMED_KEY_TOKENS.indexOf(token) >= 0) return true;
			// f1..f24 function keys
			return /^f([1-9]|1\d|2[0-4])$/.test(token);
		}

		/**
		 * Parse a canonical combo string ("ctrl+shift+v", "f9", "alt", "alt+space")
		 * into { mods, key, modOnly }. Returns null for malformed combos.
		 * modOnly marks a modifier-only trigger: "alt" → key "alt", no mods.
		 */
		function parseHotkeyCombo(combo) {
			if (typeof combo !== "string") return null;
			const parts = combo.toLowerCase().split("+").map((s) => s.trim()).filter((s) => s !== "");
			if (parts.length === 0) return null;
			const mods = { alt: false, ctrl: false, shift: false, meta: false };
			const keys = [];
			for (const part of parts) {
				if (part === "alt" || part === "option") mods.alt = true;
				else if (part === "ctrl" || part === "control") mods.ctrl = true;
				else if (part === "shift") mods.shift = true;
				else if (part === "meta" || part === "cmd" || part === "command" || part === "super" || part === "win") mods.meta = true;
				else keys.push(part);
			}
			if (keys.length === 0) {
				// Modifier-only combo: exactly one modifier, used as the trigger.
				const pressed = Object.keys(mods).filter((m) => mods[m]);
				if (pressed.length !== 1) return null;
				return { mods: { alt: false, ctrl: false, shift: false, meta: false }, key: pressed[0], modOnly: true };
			}
			if (keys.length !== 1 || !isValidKeyToken(keys[0])) return null;
			return { mods, key: keys[0], modOnly: false };
		}

		/** Resolve a stored hotkey (preset name or "custom:<combo>") to a parsed
		 *  combo. Presets: "alt" parses directly; "alt-space" is the hyphenated
		 *  preset name for the "alt+space" chord. */
		function parseHotkey(hotkey) {
			if (typeof hotkey !== "string") return null;
			if (HOTKEYS.indexOf(hotkey) >= 0) return parseHotkeyCombo(hotkey === "alt-space" ? "alt+space" : hotkey);
			if (hotkey.indexOf(CUSTOM_HOTKEY_PREFIX) === 0) return parseHotkeyCombo(hotkey.slice(CUSTOM_HOTKEY_PREFIX.length));
			return null;
		}

		/** Normalise free-typed input ("Ctrl + Shift + V") into a canonical combo or "". */
		function canonicalComboText(text) {
			const combo = String(text == null ? "" : text).toLowerCase().split("+").map((s) => s.trim()).filter((s) => s !== "").join("+");
			return parseHotkeyCombo(combo) ? combo : "";
		}

		/**
		 * Serialize a KeyboardEvent into a canonical combo string, or null when
		 * the event is a modifier keydown (the start of a chord — the keyup
		 * capture path accepts a modifier released alone).
		 */
		function serializeEventKey(event) {
			const key = normalizeKeyToken(event.key);
			if (isModifierToken(key)) return null;
			const mods = [];
			if (event.ctrlKey) mods.push("ctrl");
			if (event.altKey) mods.push("alt");
			if (event.shiftKey) mods.push("shift");
			if (event.metaKey) mods.push("meta");
			const combo = mods.concat(key).join("+");
			return parseHotkeyCombo(combo) ? combo : null;
		}

		/** Human-readable label for a hotkey ("Alt", "Alt+Space", "Ctrl+Shift+V"). */
		function hotkeyDisplay(hotkey) {
			let combo = hotkey == null ? readHotkey() : hotkey;
			if (HOTKEYS.indexOf(combo) >= 0) return combo === "alt" ? "Alt" : "Alt+Space";
			if (typeof combo === "string" && combo.indexOf(CUSTOM_HOTKEY_PREFIX) === 0) combo = combo.slice(CUSTOM_HOTKEY_PREFIX.length);
			const parsed = parseHotkeyCombo(combo);
			if (!parsed) return "Alt";
			const label = [];
			if (parsed.mods.ctrl) label.push("Ctrl");
			if (parsed.mods.alt) label.push("Alt");
			if (parsed.mods.shift) label.push("Shift");
			if (parsed.mods.meta) label.push("Meta");
			label.push(displayKeyToken(parsed.key));
			return label.join("+");
		}

		/** Title-case a canonical key token for display. */
		function displayKeyToken(token) {
			if (token.length === 1) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1); // Space, Enter, F9, ...
		}

		/**
		 * The active hotkey's label, read fresh so a settings change (or a
		 * session change) is reflected the next time a status string is built.
		 */
		function activeTriggerName() {
			return hotkeyDisplay();
		}

		/** Keyup matcher for ending a hold: releasing the trigger key or any
		 *  modifier that is part of the combo ends the hold (users release in
		 *  any order).
		 *  The RELEASE test deliberately ignores the other modifiers: Alt+Shift is
		 *  the Windows input-language switch, so the user is holding Alt exactly
		 *  when Shift goes down — reusing the keydown matcher (which requires
		 *  !shiftKey) meant releasing Alt then never ended the hold, leaving the
		 *  microphone live until the length cap. The generic matcher preserves
		 *  that: releasing the trigger key ("Alt") always ends the hold. */
		function matchesHoldRelease(event, hotkey) {
			const parsed = parseHotkey(hotkey);
			if (!parsed) return false;
			const token = normalizeKeyToken(event.key);
			if (token === parsed.key) return true;
			if (parsed.modOnly) return false;
			return (parsed.mods.alt && token === "alt") || (parsed.mods.ctrl && token === "ctrl")
				|| (parsed.mods.shift && token === "shift") || (parsed.mods.meta && token === "meta");
		}

		/** Match the configured hotkey from a keydown event (exact modifiers). */
		function matchesHotkey(event, hotkey) {
			const parsed = parseHotkey(hotkey);
			if (!parsed) return false;
			if (normalizeKeyToken(event.key) !== parsed.key) return false;
			if (parsed.modOnly) {
				// Modifier-only trigger ("alt", "ctrl", ...): no OTHER modifier held.
				if (event.altKey && parsed.key !== "alt") return false;
				if (event.ctrlKey && parsed.key !== "ctrl") return false;
				if (event.shiftKey && parsed.key !== "shift") return false;
				if (event.metaKey && parsed.key !== "meta") return false;
				return true;
			}
			if (parsed.mods.alt !== event.altKey) return false;
			if (parsed.mods.ctrl !== event.ctrlKey) return false;
			if (parsed.mods.shift !== event.shiftKey) return false;
			if (parsed.mods.meta !== event.metaKey) return false;
			return true;
		}
		//#endregion

		//#region hotkey handling
		/** Is the element an editable field (input / textarea / contenteditable)? */
		function isEditableElement(el) {
			if (!el) return false;
			const tag = el.tagName;
			return tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable === true;
		}

		/** Is the editable element the composer (or inside it)? */
		function isComposerEditable(el) {
			if (!el || typeof el.closest !== "function") return false;
			// DSH 0.1.2+ renders the composer as a Lexical contenteditable inside
			// [data-composer-card]; there is no textarea to match any more, so
			// containment in the composer card is the reliable test (it also keeps
			// Alt working while the composer - the normal case - has focus).
			if (el.closest('[data-composer-card="true"]') || el.closest("[data-composer-card]")) return true;
			const editor = findComposerEditor();
			return editor !== null && (el === editor || editor.contains(el));
		}

		let lastToggleAt = 0;
		function onKeyDown(event) {
			const hotkey = readHotkey();
			if (!matchesHotkey(event, hotkey)) return;
			if (event.repeat) return; // holding Alt+Space must not re-toggle
			// Never hijack Alt while the user is typing in a non-composer field
			// (search box, settings inputs…) — toggling recording there is a
			// surprise, and Alt is often needed for input methods.
			const active = document.activeElement;
			if (active && isEditableElement(active) && !isComposerEditable(active)) return;
			// Push-to-talk: keydown starts the hold, keyup (below) stops it.
			if (readMode() === "hold") {
				event.preventDefault();
				event.stopPropagation();
				beginHold();
				return;
			}
			// Swallow the key's default action FIRST: returning inside the debounce
			// window used to let the browser act on a bare Alt (focus the menu bar).
			event.preventDefault();
			event.stopPropagation();
			// Debounce double-toggles.
			const now = Date.now();
			if (now - lastToggleAt < HOTKEY_DEBOUNCE_MS) return;
			lastToggleAt = now;
			toggleRecording();
		}

		/** Push-to-talk release: stop + transcribe. */
		function onKeyUp(event) {
			if (readMode() !== "hold") return;
			if (!matchesHoldRelease(event, readHotkey())) return;
			if (!holdActive) return;
			event.preventDefault();
			event.stopPropagation();
			endHold();
		}

		/** Losing the window mid-recording must not leave the mic on. Hold mode
		 *  treats blur as the release gesture (transcribe); tap mode cancels —
		 *  Alt+Tab starts recording on the Alt keydown and the user never
		 *  intended text for the composer. */
		function onWindowBlur() {
			// getUserMedia may still be pending (permission prompt / slow device):
			// the recorder would then start AFTER the user left the window, with the
			// mic hot and nothing to stop it. Flag it so the start aborts on arrival.
			if (startPending) {
				cancelPendingStart = true;
				holdActive = false;
				holdStopPending = false;
				return;
			}
			if (holdActive) {
				endHold();
				return;
			}
			if (wsRecording) {
				discardWsOnEnd = true;
				stopWebSpeech();
			} else if (recording) {
				discardOnStop = true;
				stopRecording();
			}
		}

		function mountHotkey() {
			window.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("keyup", onKeyUp, true);
			window.addEventListener("blur", onWindowBlur);
		}
		function unmountHotkey() {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onWindowBlur);
			// Disabling/reloading the plugin must release capture immediately and
			// prevent pending ASR/polish work from writing into a retired composer.
			clientLifecycle++;
			wsTake++;
			cancelPendingStart = true;
			holdActive = false;
			holdStopPending = false;
			if (wsStopWatchdog !== null) { clearTimeout(wsStopWatchdog); wsStopWatchdog = null; }
			if (recognition) {
				recognition.onresult = recognition.onerror = recognition.onend = null;
				try { recognition.abort(); } catch { /* already ended */ }
				recognition = null;
			}
			wsRecording = false;
			pendingWsStop = false;
			if (recorder) {
				recorder.ondataavailable = recorder.onstop = null;
				try { recorder.stop(); } catch { /* already inactive */ }
				recorder = null;
			}
			if (stream) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
			}
			recording = false;
			recordingStopping = false;
			busy = false;
			if (recordingCapTimer) { clearTimeout(recordingCapTimer); recordingCapTimer = null; }
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			previewTake++;
			stopLevelMeter();
			rollbackPreview(previewBaseline);
			for (const controller of hostControllers) controller.abort();
			if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
			if (statusEl) statusEl.style.opacity = "0";
			syncMicState();
		}
		//#endregion

		//#region boot
		function boot() {
			mountHotkey();
			// Pre-fetch settings so the first transcribe has the host defaults in view (harmless).
			void fetchSettings().then(applyHostSettings).catch(() => {});
			// Warm the local-model readiness flag so "auto" can route correctly
			// on the very first Alt tap.
			void refreshLocalStatus().catch(() => {});
		}

		/** Auto-fallback: browser speech is unreachable → prep the local engine. */
		async function autoFallbackToLocal() {
			setStatus("🔁 浏览器识别不可用，正在切换本地离线识别（首次使用需下载模型约 230MB，只需一次）…", true);
			if (localReady) {
				setStatus("🔁 已切换到本地离线识别，请再按一次 " + activeTriggerName(), true);
				return;
			}
			const ok = await ensureLocalModel();
			if (ok) setStatus("✅ 本地识别模型已就绪，请再按一次 " + activeTriggerName() + " 开始说话", true);
		}
		//#endregion

		//#region dsh-voice-scribe: settings UI
		/** The settings section's locale namespace. */
		const SETTINGS_NS = "settings.voicePolish";
		/** Settings section id used for slots registration. */
		const SETTINGS_SECTION_ID = "voice-scribe";

		/** Settings row dictionaries — nested per-locale (the shape DSH's locale service expects). */
		const settingsLocale = {
			zh: {
				"section.title": "AI 整理（语音/文本）",
				"engine.title": "识别引擎",
				"engine.auto": "自动（推荐）：本地离线识别优先，浏览器识别不可用时自动切换",
				"engine.web-speech": "浏览器内置识别（Web Speech）",
				"engine.local": "本地离线识别（SenseVoice，零配置、零 key、不出本机）",
				"engine.cloud-asr": "云端 ASR（OpenAI 兼容，需配置 API key）",
				"local.ready": "✅ 本地识别模型已就绪",
				"local.downloading": "⏳ 本地识别模型下载中…",
				"local.missing": "ℹ️ 本地识别模型未下载（首次使用自动下载约 230MB，只需一次）",
				"language.title": "识别语言",
				"language.auto": "自动（跟随系统）",
				"language.note": "支持中/英/粤/日/韩；本地离线识别会自动检测语言，此选项作用于浏览器与云端识别。",
				"device.title": "麦克风设备",
				"device.default": "系统默认（由浏览器决定）",
				"device.unnamed": "麦克风 {n}（授权一次后显示名称）",
				"device.missing": "已保存的设备（当前不可用）",
				"device.note": "上次录音实际使用的是：{name}",
				"device.noteEmpty": "尚未录音。设备名称需要授权一次才能读取；「系统默认」由浏览器决定，可能与系统默认设备不同——若电平条不动或识别为空，请在这里指定设备。",
				"hotkey.title": "热键",
				"hotkey.alt": "Alt（点按切换）",
				"hotkey.alt-space": "Alt + 空格",
				"hotkey.custom": "自定义…",
				"hotkey.customHint": "支持任意组合键（如 Ctrl+Shift+V、F9、Alt+Space）：点击「记录」后按下你的快捷键，松开单个修饰键即为单键热键；也可直接往输入框里输入。",
				"hotkey.record": "记录",
				"hotkey.recording": "记录中…（Esc 或再点取消）",
				"hotkey.save": "保存",
				"hotkey.saved": "✅ 已保存",
				"hotkey.invalid": "❌ 无法识别的组合键",
				"hotkey.placeholder": "尚未记录快捷键",
				"mode.title": "触发方式",
				"mode.tap": "点按切换：按一下开始，再按一下结束",
				"mode.hold": "按住说话：按住录音，松开自动转写",
				"polish.title": "AI 整理（使用 DSH 已配模型）",
				"polish.on": "开启",
				"polish.off": "关闭",
				"polish.modelTitle": "润色模型",
				"polish.modelEmpty": "未检测到可用模型。请先在 DSH 设置 → 模型 中配置一个 provider（推荐 Kiro Claude Sonnet 4.5），或任意 OpenAI 兼容接口。",
				"polish.modelFailed": "读取模型列表失败",
				"hint": "点击输入框旁的 ✦ 整理 按钮（或配合 Win+H 系统语音输入先说话再点按钮），当前草稿会通过所选模型清理口头禅、改同音错字、补标点，并保留专有名词；失败时输入框原文不变。",
				"prompt.title": "润色提示词（自定义）",
				"prompt.placeholder": "留空使用默认提示词（保守清理：删填充词/补标点/修同音错字/保留专有名词与英文原文/带 4 条 few-shot 示例，总长约 1500 字）。想改语气（更正式/更口语/技术文档）在上方「语气预设」里挑一个复制过来，或完全自定义写在这里。",
				"prompt.saved": "✅ 已保存，下次润色生效",
				"prompt.failed": "❌ 保存失败",
				"prompt.reset": "恢复默认",
				"prompt.resetDone": "✅ 已恢复默认",
				"hw.title": "热词替换表（hot.txt，可选）",
				"hw.loaded": "已加载 {n} 条替换规则，每次转写后自动应用",
				"hw.empty": "未创建热词表",
				"hw.error": "解析出错",
				"hw.note": "文件位置：$DSH_HOME/voice/hot.txt。每行一条：正确词=错误词1|错误词2，或 /正则/替换/flags。用于把识别错的人名、术语、项目名替换回来；修改保存后立即生效，整理前先跑一遍热词替换。",
				"cloud.title": "云端 ASR 配置（服务端保存，key 不进浏览器）",
				"cloud.url": "接口地址 (Base URL)",
				"cloud.model": "模型 (Model)",
				"cloud.key": "API Key",
				"cloud.keySet": "已配置（留空保持不变）",
				"cloud.save": "保存配置",
				"cloud.saved": "✅ 配置已保存",
				"cloud.failed": "❌ 保存失败",
				"cloud.placeholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.placeholderModel": "whisper-large-v3",
				"cloud.urlInvalid": "❌ 接口地址需以 http(s):// 开头",
				"cloud.clearKey": "清除已保存 Key",
				"cloud.keyCleared": "✅ 已清除",
				"cloud.providerTitle": "云端服务链（按顺序尝试，失败自动切换下一个）",
				"cloud.addProvider": "+ 添加服务",
				"cloud.removeProvider": "移除",
				"cloud.providerPlaceholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.providerPlaceholderModel": "whisper-large-v3",
				"mic.tooltip": "语音输入（Alt）",
				"mic.tooltipHold": "语音输入（按住说话）",
				"mic.recording": "录音中…点击停止",
				"mic.transcribing": "转写中…",
				"mic.unavailable": "语音输入暂不可用",
				"warn.wsUnsupported": "⚠️ 当前浏览器不支持 Web Speech，请用 Chrome/Edge，或切换到云端引擎",
				"warn.wsChrome": "⚠️ Chrome 的浏览器识别依赖 Google 服务，国内网络通常不可用。建议使用 Edge（微软服务，国内可用）或切换「云端 ASR」",
				"warn.noKey": "⚠️ 尚未配置 API key，云端转写会失败"
			},
			en: {
				"section.title": "AI Polish",
				"engine.title": "Recognition engine",
				"engine.auto": "Auto (recommended): local offline first, falls back when Web Speech is unavailable",
				"engine.web-speech": "Browser Web Speech",
				"engine.local": "Local offline (SenseVoice, zero config, audio never leaves the machine)",
				"engine.cloud-asr": "Cloud ASR (OpenAI-compatible, requires API key)",
				"local.ready": "✅ Local model ready",
				"local.downloading": "⏳ Local model downloading…",
				"local.missing": "ℹ️ Local model not downloaded (auto-downloads ~230MB on first use, once)",
				"language.title": "Recognition language",
				"language.auto": "Auto (follow system)",
				"language.note": "Chinese / English / Cantonese / Japanese / Korean supported. The local offline engine auto-detects the language; this choice applies to browser and cloud recognition.",
				"device.title": "Microphone device",
				"device.default": "System default (chosen by the browser)",
				"device.unnamed": "Microphone {n} (name appears after one recording)",
				"device.missing": "Saved device (currently unavailable)",
				"device.note": "Last recording actually used: {name}",
				"device.noteEmpty": "No recording yet. Device names need one granted recording to be readable; \"System default\" is decided by the browser and can differ from the OS default — if the level meter stays flat or nothing is transcribed, pin a device here.",
				"hotkey.title": "Hotkey",
				"hotkey.alt": "Alt (tap to toggle)",
				"hotkey.alt-space": "Alt + Space",
				"hotkey.custom": "Custom…",
				"hotkey.customHint": "Any key combination (e.g. Ctrl+Shift+V, F9, Alt+Space): click Record and press your shortcut; releasing a modifier alone makes it a single-key hotkey. You can also type it in the box.",
				"hotkey.record": "Record",
				"hotkey.recording": "Recording… (Esc or click again to cancel)",
				"hotkey.save": "Save",
				"hotkey.saved": "✅ Saved",
				"hotkey.invalid": "❌ Unrecognized key combination",
				"hotkey.placeholder": "No shortcut recorded yet",
				"mode.title": "Trigger mode",
				"mode.tap": "Tap to toggle: press to start, press again to stop",
				"mode.hold": "Push-to-talk: hold to record, release to transcribe",
				"polish.title": "Polish (reuse DSH model)",
				"polish.on": "On",
				"polish.off": "Off",
				"polish.modelTitle": "Polish model",
				"polish.modelEmpty": "No model available — configure a provider in DSH Settings → Models first.",
				"polish.modelFailed": "Failed to load the model list",
				"hint": "When on, the transcript is cleaned (fillers removed, punctuation fixed) by a DSH-configured model; the raw transcript is kept if polishing fails.",
				"prompt.title": "Polish prompt (custom)",
				"prompt.placeholder": "Leave empty to use the default (safe cleanup: remove fillers, add punctuation, fix homophones, keep proper nouns and English intact; includes 4 few-shot examples, ~1500 chars). To change tone (formal/casual/tech-doc), pick a preset above; or write your own here.",
				"prompt.saved": "✅ Saved — applies to the next polish",
				"prompt.failed": "❌ Save failed",
				"prompt.reset": "Reset to default",
				"prompt.resetDone": "✅ Reset to default",
				"hw.title": "Hot words / replacement table (hot.txt, optional)",
				"hw.loaded": "{n} replacement rules loaded, applied after every transcription",
				"hw.empty": "No hot-word table yet",
				"hw.error": "Parse error",
				"hw.note": "One rule per line: correct=wrong1|wrong2, or /regex/replacement/flags. Use it to fix mis-recognized names, terms and project names; changes apply on the next transcription.",
				"cloud.title": "Cloud ASR config (stored server-side; key never enters the browser)",
				"cloud.url": "Base URL",
				"cloud.model": "Model",
				"cloud.key": "API Key",
				"cloud.keySet": "Configured (leave blank to keep)",
				"cloud.save": "Save config",
				"cloud.saved": "✅ Config saved",
				"cloud.failed": "❌ Save failed",
				"cloud.placeholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.placeholderModel": "whisper-large-v3",
				"cloud.urlInvalid": "❌ Base URL must start with http(s)://",
				"cloud.clearKey": "Clear saved key",
				"cloud.keyCleared": "✅ Cleared",
				"cloud.providerTitle": "Cloud provider chain (tried in order, auto-fails-over)",
				"cloud.addProvider": "+ Add provider",
				"cloud.removeProvider": "Remove",
				"cloud.providerPlaceholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.providerPlaceholderModel": "whisper-large-v3",
				"mic.tooltip": "Voice input (Alt)",
				"mic.tooltipHold": "Voice input (push-to-talk)",
				"mic.recording": "Recording… click to stop",
				"mic.transcribing": "Transcribing…",
				"mic.unavailable": "Voice input unavailable",
				"warn.wsUnsupported": "⚠️ Web Speech is unsupported in this browser — use Chrome/Edge or switch to the cloud engine.",
				"warn.wsChrome": "⚠️ Chrome's Web Speech relies on Google's service, usually unreachable in mainland-China networks. Use Edge (Microsoft service, works) or switch to cloud ASR.",
				"warn.noKey": "⚠️ No API key configured — cloud transcription will fail."
			}
		};

		/** Small labelled select row. */
		function SelectRow({ label, value, options, onChange }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0" },
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						style: { flex: "1", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
						children: label
					}),
					(0, react_jsx_runtime.jsx)("select", {
						value: value,
						onChange: (event) => onChange(event.target.value),
						style: {
							background: "var(--dsw-alias-bg-layer-1)",
							color: "var(--dsw-alias-label-primary)",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "8px",
							padding: "4px 8px",
							fontSize: "13px",
							maxWidth: "260px"
						},
						children: options.map((opt) => (0, react_jsx_runtime.jsx)("option", { value: opt.value, children: opt.label }, opt.value))
					})
				]
			});
		}

		/** The settings section shell: renders the registered items. */
		function VoiceScribeSection({ renderSlot }) {
			return (0, react_jsx_runtime.jsx)("div", {
				style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 0" },
				children: renderSlot("settings.voiceScribe.item", {})
			});
		}


		/** The main settings row: engine / language / hotkey / polish toggle + cloud-ASR config. */
		function VoiceScribeRow({ t }) {
			// Local re-render tick so changing a select immediately updates the UI
			// (settings live in localStorage; the row re-reads them on each render).
			const [, forceRender] = _react.useState(0);
			const engine = readEngine();
			const language = readLanguage();
			const hotkey = readHotkey();
			const hotkeyIsCustom = typeof hotkey === "string" && hotkey.indexOf(CUSTOM_HOTKEY_PREFIX) === 0;
			const mode = readMode();
			const polishOn = readPolishEnabled();
			const bump = () => forceRender((n) => n + 1);

			// Capture-device state. enumerateDevices() is async and its labels stay
			// EMPTY until the microphone was granted once, so this row never calls
			// getUserMedia by itself (that would light the mic indicator just from
			// opening a settings page) — placeholder names carry that case instead.
			const [deviceId, setDeviceId] = _react.useState(readDeviceId());
			const [devices, setDevices] = _react.useState([]);
			_react.useEffect(() => {
				let alive = true;
				const sync = () => {
					void refreshAudioInputs().then((list) => { if (alive) setDevices(list.slice()); });
				};
				sync();
				const md = navigator.mediaDevices;
				// Headsets and virtual cables come and go: keep the list honest.
				if (md && typeof md.addEventListener === "function") md.addEventListener("devicechange", sync);
				return () => {
					alive = false;
					if (md && typeof md.removeEventListener === "function") md.removeEventListener("devicechange", sync);
				};
			}, []);

			// Custom-hotkey recorder state (used only when "custom" is selected).
			const [customHotkey, setCustomHotkey] = _react.useState(readCustomHotkeyCombo() || "");
			const [capturingHotkey, setCapturingHotkey] = _react.useState(false);
			const [customStatus, setCustomStatus] = _react.useState("");
			const customInputRef = _react.useRef(null);
			// Which option the dropdown shows. The user can pick "custom" and
			// record a combo BEFORE saving it — the stored hotkey only changes
			// on Save, so the dropdown value must NOT be derived from
			// readHotkey() alone (that would snap back to the active preset).
			const [hotkeyChoice, setHotkeyChoice] = _react.useState(hotkeyIsCustom ? "custom" : hotkey);

			/** Save the edited custom combo (validates the free-text input). */
			const saveCustomHotkey = () => {
				const combo = canonicalComboText(customHotkey);
				if (!combo) { setCustomStatus(t("hotkey.invalid")); return; }
				writeJson(HOTKEY_KEY, CUSTOM_HOTKEY_PREFIX + combo);
				setCustomHotkey(combo);
				setCustomStatus(t("hotkey.saved"));
				setCapturingHotkey(false);
				bump();
			};

			// Cloud-ASR config state: an ordered provider chain (tried in order,
			// fail-over to the next on error). Loaded from host on mount.
			const [providers, setProviders] = _react.useState([{ url: "", model: "", key: "", hasKey: false }]);
			const [cloudStatus, setCloudStatus] = _react.useState("");
			// Local offline engine status (model ready / downloading / missing).
			const [localInfo, setLocalInfo] = _react.useState(null);
			// Custom polish prompt (host-side setting; "" = built-in default).
			const [polishPromptText, setPolishPromptText] = _react.useState("");
			const [promptStatus, setPromptStatus] = _react.useState("");
			// Hot-word table status (path / rule count / first parse error).
			const [hotwordsInfo, setHotwordsInfo] = _react.useState(null);
			// Polish model routes (host list-models). The polish gate needs a
			// provider+model pair, and NOTHING used to write it — so the toggle was
			// inert. Default to the first available route when none is saved.
			const [polishRoutes, setPolishRoutes] = _react.useState(null);
			const [polishRouteError, setPolishRouteError] = _react.useState("");

			const polishRouteValue = () => {
				const saved = readPolishModel();
				return saved && saved.provider && saved.model ? JSON.stringify({ provider: saved.provider, model: saved.model }) : "";
			};

			_react.useEffect(() => {
				if (!polishOn) return;
				let cancelled = false;
				void listModels().then((routes) => {
					if (cancelled) return;
					setPolishRoutes(routes);
					const saved = readPolishModel();
					if (saved && saved.provider && saved.model) return;
					const first = routes[0];
					if (first) writeJson(POLISH_MODEL_KEY, { provider: first.provider, model: first.model });
				}).catch(() => {
					if (cancelled) return;
					setPolishRoutes([]);
					setPolishRouteError(t("polish.modelFailed"));
				});
				return () => { cancelled = true; };
			}, [polishOn]);

			_react.useEffect(() => {
				let cancelled = false;
				void hostCall({ action: "local-status" }).then((data) => {
					if (cancelled || !(data && data.ok === true && data.value)) return;
					setLocalInfo(data.value);
					if (typeof data.value.modelReady === "boolean") localReady = data.value.modelReady;
					if (data.value.downloading === true) {
						// Poll while the first-use model download is running.
						let tries = 0;
						const timer = setInterval(() => {
							tries++;
							void hostCall({ action: "local-status" }).then((d2) => {
								if (cancelled) { clearInterval(timer); return; }
								if (d2 && d2.ok === true && d2.value) {
									setLocalInfo(d2.value);
									localReady = d2.value.modelReady === true;
									if (d2.value.modelReady === true || d2.value.error) clearInterval(timer);
								}
							}).catch(() => {});
							if (tries > 120) clearInterval(timer);
						}, 3000);
					}
				}).catch(() => {});
				void fetchSettings().then((value) => {
					if (cancelled || !value) return;
					if (Array.isArray(value.providers) && value.providers.length > 0) {
						setProviders(value.providers.map((p) => ({
							url: (p && typeof p.url === "string") ? p.url : "",
							model: (p && typeof p.model === "string") ? p.model : "",
							key: "",
							hasKey: !!(p && p.hasKey === true)
						})));
					} else {
						// Back-compat: host without providers view → single legacy group.
						setProviders([{
							url: typeof value.asrUrl === "string" ? value.asrUrl : "",
							key: "",
							hasKey: value.hasKey === true
						}]);
					}
					// Keep the localStorage language in sync with the host default
					// when the user has not chosen one yet.
					if (typeof value.language === "string" && value.language !== "" && readLanguage() === "") {
						writeJson(LANGUAGE_KEY, value.language);
						bump();
					}
					// Custom polish prompt + hot-word table status (host-side).
					if (typeof value.polishPrompt === "string") {
						setPolishPromptText(value.polishPrompt);
					}
					if (value.hotwords && typeof value.hotwords === "object") {
						setHotwordsInfo(value.hotwords);
					}
				}).catch(() => {});
				return () => { cancelled = true; };
			}, []);

			// Custom-hotkey capture: while armed, absorb keydown/keyup on the
			// window and translate the pressed chord into a canonical combo.
			// A modifier released alone (e.g. Alt) becomes a modifier-only
			// hotkey; pressing a non-modifier key captures the full chord.
			_react.useEffect(() => {
				if (!capturingHotkey) return undefined;
				let pendingMod = null;
				const onCaptureKeyDown = (event) => {
					if (event.key === "Escape") {
						setCustomHotkey(readCustomHotkeyCombo() || "");
						setCapturingHotkey(false);
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					const token = normalizeKeyToken(event.key);
					if (isModifierToken(token)) { pendingMod = token; return; }
					const combo = serializeEventKey(event);
					if (combo) {
						pendingMod = null;
						setCustomHotkey(combo);
						setCustomStatus("");
						setCapturingHotkey(false);
					}
				};
				const onCaptureKeyUp = (event) => {
					if (pendingMod === null) return;
					if (normalizeKeyToken(event.key) === pendingMod) {
						const combo = pendingMod;
						pendingMod = null;
						event.preventDefault();
						event.stopPropagation();
						setCustomHotkey(combo);
						setCustomStatus("");
						setCapturingHotkey(false);
					}
				};
				window.addEventListener("keydown", onCaptureKeyDown, true);
				window.addEventListener("keyup", onCaptureKeyUp, true);
				return () => {
					window.removeEventListener("keydown", onCaptureKeyDown, true);
					window.removeEventListener("keyup", onCaptureKeyUp, true);
				};
			}, [capturingHotkey]);

			// When capture is armed (from the dropdown or the Record button),
			// move focus into the recorder input so the plugin's own hotkey
			// guard (editable, non-composer) applies — otherwise pressing the
			// currently active hotkey (e.g. Alt) would start recording while
			// the user is only trying to record a new one.
			_react.useEffect(() => {
				if (capturingHotkey && customInputRef.current) customInputRef.current.focus();
			}, [capturingHotkey, hotkeyChoice]);

			/** Update one field of the provider at index i. */
			const updateProvider = (i, field, value) => {
				setProviders((prev) => prev.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
			};

			const addProvider = () => {
				setProviders((prev) => prev.length >= MAX_ASR_PROVIDERS ? prev : [...prev, { url: "", model: "", key: "", hasKey: false }]);
			};

			const removeProvider = (i) => {
				setProviders((prev) => prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i));
			};

			const saveCloud = () => {
				setCloudStatus("");
				// Validate every URL; drop empty rows.
				const chain = [];
				for (const p of providers) {
					const url = (p.url || "").trim();
					if (url === "") continue;
					if (!/^https?:\/\//i.test(url)) {
						setCloudStatus(t("cloud.urlInvalid"));
						return;
					}
					const row = { url, model: (p.model || "").trim() };
					if ((p.key || "").trim() !== "") row.key = p.key.trim();
					chain.push(row);
				}
				if (chain.length === 0) {
					setCloudStatus(t("cloud.urlInvalid"));
					return;
				}
				// Also retire the legacy single-endpoint fields (asrUrl / asrModel /
				// asrApiKey). The host folds them back in as provider #1 whenever they
				// are present, so leaving them behind made every save duplicate row #1
				// until the 4-provider cap filled up with identical endpoints — and
				// "清除已保存 Key" left the folded legacy key still authenticating, so
				// the host kept reporting hasKey: true. A null value deletes the field.
				void saveSettings({ asrProviders: chain, asrUrl: null, asrModel: null, asrApiKey: null }).then((ok) => {
					setCloudStatus(ok ? t("cloud.saved") : t("cloud.failed"));
					if (ok) {
						// Rebuild the edited rows with hasKey from the source
						// of truth: any row that had a key before the save, or
						// received a freshly typed one. (The host keeps old
						// keys for rows saved with an empty key field.)
						setProviders((prev) => {
							const byUrl = new Map(chain.map((c, idx) => [c.url, { c, idx }]));
							return prev.map((p, idx) => {
								const match = byUrl.get((p.url || "").trim());
								const saved = match && match.c ? match.c : null;
								return {
									url: saved ? saved.url : p.url,
									model: saved ? saved.model : p.model,
									key: "",
									hasKey: p.hasKey || !!(saved && saved.key)
								};
							}).filter((p) => p.url !== "");
						});
					}
					bump();
				}).catch(() => {
					setCloudStatus(t("cloud.failed"));
					bump();
				});
			};

			/** Save the custom polish prompt ("" resets to the built-in default). */
			const savePolishPrompt = (value) => {
				setPromptStatus("");
				void saveSettings({ polishPrompt: value }).then((ok) => {
					setPromptStatus(ok ? (value.trim() === "" ? t("prompt.resetDone") : t("prompt.saved")) : t("prompt.failed"));
					bump();
				}).catch(() => {
					setPromptStatus(t("prompt.failed"));
					bump();
				});
			};

			/** Remove the stored ASR keys on the host — keep url/model rows. */
			const clearCloudKey = () => {
				setCloudStatus("");
				// Preserve every row's url+model, blank only the keys (host
				// deletes a key when its string is "" — see set-settings).
				const chain = providers
					.map((p) => ({ url: (p.url || "").trim(), model: (p.model || "").trim(), key: "" }))
					.filter((p) => p.url !== "");
				// Also retire the legacy single-endpoint fields (asrUrl / asrModel /
				// asrApiKey). The host folds them back in as provider #1 whenever they
				// are present, so leaving them behind made every save duplicate row #1
				// until the 4-provider cap filled up with identical endpoints — and
				// "清除已保存 Key" left the folded legacy key still authenticating, so
				// the host kept reporting hasKey: true. A null value deletes the field.
				void saveSettings({ asrProviders: chain, asrUrl: null, asrModel: null, asrApiKey: null }).then((ok) => {
					setCloudStatus(ok ? t("cloud.keyCleared") : t("cloud.failed"));
					if (ok) {
						setProviders((prev) => prev.map((p) => ({ ...p, key: "", hasKey: false })));
						bump();
					}
				}).catch(() => {
					setCloudStatus(t("cloud.failed"));
					bump();
				});
			};

			// Engine-specific inline warning (unsupported Web Speech / missing key).
			// Chrome's Web Speech routes to Google (unreachable on mainland-China
			// networks); Edge routes to Microsoft (works). Steer Chrome users away.
			const isChrome = typeof navigator !== "undefined"
				&& /Chrome\//.test(navigator.userAgent || "")
				&& !/Edg\//.test(navigator.userAgent || "");
			// A key counts as present when the host reports one stored
			// (hasKey) or the user has just typed one into a row.
			const cloudHasKey = providers.some((p) => p.hasKey || (typeof p.key === "string" && p.key.trim() !== ""));
			const engineWarn = engine === "web-speech"
				? (webSpeechSupported()
					? (isChrome ? t("warn.wsChrome") : "")
					: t("warn.wsUnsupported"))
				// Only the cloud engine needs an API key — warning about a
				// missing key on auto/local was plain wrong (both are keyless).
				: (engine === "cloud-asr" ? (cloudHasKey ? "" : t("warn.noKey")) : "");

			/** Polish model picker: routes come from the host list-models action. */
			const polishModelRow = () => {
				if (!polishOn) return null;
				if (polishRoutes !== null && polishRoutes.length === 0) {
					return (0, react_jsx_runtime.jsx)("div", {
						style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", padding: "4px 0" },
						children: polishRouteError || t("polish.modelEmpty")
					});
				}
				return (0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("polish.modelTitle"),
					value: polishRouteValue(),
					options: (polishRoutes || []).map((route) => ({
						value: JSON.stringify({ provider: route.provider, model: route.model }),
						label: (route.providerName || route.provider) + " · " + (route.modelName || route.model)
					})),
					onChange: (v) => {
						try {
							const picked = JSON.parse(v);
							if (picked && picked.provider && picked.model) writeJson(POLISH_MODEL_KEY, { provider: picked.provider, model: picked.model });
						} catch { /* ignore malformed value */ }
						bump();
					}
				});
			};

			/** Custom-hotkey recorder row (only rendered while "custom" is selected). */
			const customHotkeyRow = () => {
				if (hotkeyChoice !== "custom") return null;
				const display = customHotkey || (capturingHotkey ? t("hotkey.recording") : t("hotkey.placeholder"));
				return (0, react_jsx_runtime.jsxs)("div", {
					"data-voice-scribe-setting": "1",
					style: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 0 4px", fontSize: "12px" },
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							style: { color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" },
							children: t("hotkey.customHint")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "8px" },
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									ref: customInputRef,
									type: "text",
									value: display,
									placeholder: t("hotkey.placeholder"),
									onChange: (event) => { setCustomHotkey(event.target.value); setCustomStatus(""); },
									style: {
										flex: "1",
										minWidth: "140px",
										boxSizing: "border-box",
										background: "var(--dsw-alias-bg-layer-1)",
										color: "var(--dsw-alias-label-primary)",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: "8px",
										padding: "6px 10px",
										fontSize: "13px",
										fontFamily: "monospace"
									}
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										if (capturingHotkey) {
											// Cancel: show the still-active saved hotkey again.
											setCustomHotkey(readCustomHotkeyCombo() || "");
											setCapturingHotkey(false);
											return;
										}
										setCustomStatus("");
										setCustomHotkey("");
										setCapturingHotkey(true);
										bump();
										// Focus the recorder input so the plugin's
										// own hotkey guard (editable, non-composer)
										// applies while keys are being captured.
										if (customInputRef.current) customInputRef.current.focus();
									},
									style: {
										background: "transparent",
										color: "var(--dsw-alias-label-secondary)",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: "8px",
										padding: "6px 12px",
										fontSize: "12px",
										cursor: "pointer",
										whiteSpace: "nowrap"
									},
									children: capturingHotkey ? t("hotkey.recording") : t("hotkey.record")
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: saveCustomHotkey,
									style: {
										background: "var(--dsw-alias-button-info-fill, #5e6ad2)",
										color: "#fff",
										border: "none",
										borderRadius: "8px",
										padding: "6px 14px",
										fontSize: "13px",
										cursor: "pointer",
										whiteSpace: "nowrap"
									},
									children: t("hotkey.save")
								})
							]
						}),
						customStatus ? (0, react_jsx_runtime.jsx)("div", {
							style: { color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" },
							children: customStatus
						}) : null
					]
				});
			};

			const deviceOptions = [{ value: "", label: t("device.default") }];
			for (let i = 0; i < devices.length; i++) {
				const dev = devices[i];
				deviceOptions.push({
					value: dev.deviceId,
					label: dev.label || String(t("device.unnamed")).replace("{n}", String(i + 1))
				});
			}
			// A saved device that is gone must stay visible: silently snapping the
			// select back to "system default" would hide the very mismatch this row
			// exists to reveal. Only shown once the list has loaded, otherwise an
			// empty list would flash "unavailable" for a perfectly fine device.
			if (deviceId && devices.length > 0 && !devices.some((dev) => dev.deviceId === deviceId)) {
				deviceOptions.push({ value: deviceId, label: t("device.missing") });
			}

			const children = [
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("engine.title"),
					value: engine,
					options: [
						{ value: "auto", label: t("engine.auto") },
						{ value: "local", label: t("engine.local") },
						{ value: "web-speech", label: t("engine.web-speech") },
						{ value: "cloud-asr", label: t("engine.cloud-asr") }
					],
					onChange: (v) => { writeJson(ENGINE_KEY, v); bump(); }
				}),
				(engine === "local" || engine === "auto") ? (0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", padding: "2px 0" },
					children: localInfo && localInfo.modelReady
						? t("local.ready")
						: (localInfo && localInfo.downloading
							? t("local.downloading") + (localInfo.progress && localInfo.progress.total > 0
								? " " + Math.min(100, Math.round(100 * localInfo.progress.done / localInfo.progress.total)) + "%"
								: "")
							: t("local.missing"))
				}) : null,
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("language.title"),
					value: language,
					options: [
						{ value: "", label: t("language.auto") },
						{ value: "zh-CN", label: "普通话 (zh-CN)" },
						{ value: "en-US", label: "English (en-US)" },
						{ value: "yue-Hant-HK", label: "粤语 (Cantonese)" },
						{ value: "ja-JP", label: "日本語 (ja-JP)" },
						{ value: "ko-KR", label: "한국어 (ko-KR)" }
					],
					onChange: (v) => { writeJson(LANGUAGE_KEY, v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", padding: "0 0 2px" },
					children: t("language.note")
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("device.title"),
					value: deviceId,
					options: deviceOptions,
					onChange: (v) => { writeDeviceId(v); setDeviceId(v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", padding: "0 0 2px" },
					children: activeDeviceLabel
						? String(t("device.note")).replace("{name}", activeDeviceLabel)
						: t("device.noteEmpty")
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("hotkey.title"),
					value: hotkeyChoice,
					options: [
						{ value: "alt", label: t("hotkey.alt") },
						{ value: "alt-space", label: t("hotkey.alt-space") },
						{ value: "custom", label: t("hotkey.custom") }
					],
					onChange: (v) => {
						if (v === "custom") {
							// Show the recorder without touching storage: a
							// recorded combo only becomes the active hotkey
							// once the user presses Save.
							const existing = readCustomHotkeyCombo();
							setHotkeyChoice("custom");
							setCustomHotkey(existing || "");
							setCustomStatus("");
							setCapturingHotkey(existing ? false : true);
							bump();
							return;
						}
						writeJson(HOTKEY_KEY, v);
						setHotkeyChoice(v);
						setCapturingHotkey(false);
						bump();
					}
				}),
				customHotkeyRow(),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("mode.title"),
					value: mode,
					options: [
						{ value: "tap", label: t("mode.tap") },
						{ value: "hold", label: t("mode.hold") }
					],
					onChange: (v) => { writeJson(MODE_KEY, v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("polish.title"),
					value: polishOn ? "on" : "off",
					options: [
						{ value: "off", label: t("polish.off") },
						{ value: "on", label: t("polish.on") }
					],
					onChange: (v) => { writeJson(POLISH_KEY, v === "on"); bump(); }
				}),
				polishModelRow(),
				polishOn ? (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: "4px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "6px" },
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
							children: t("prompt.title")
						}),
						(0, react_jsx_runtime.jsx)("textarea", {
							value: polishPromptText,
							"data-voice-scribe-setting": "1",
							placeholder: t("prompt.placeholder"),
							rows: 4,
							onChange: (event) => { setPolishPromptText(event.target.value); setPromptStatus(""); },
							style: {
								width: "100%",
								minHeight: "76px",
								boxSizing: "border-box",
								resize: "vertical",
								background: "var(--dsw-alias-bg-layer-1)",
								color: "var(--dsw-alias-label-primary)",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: "8px",
								padding: "6px 10px",
								fontSize: "12px",
								lineHeight: "18px",
								fontFamily: "inherit"
							}
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "10px" },
							children: [
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => savePolishPrompt(polishPromptText),
									style: {
										background: "var(--dsw-alias-button-info-fill, #5e6ad2)",
										color: "#fff",
										border: "none",
										borderRadius: "8px",
										padding: "6px 14px",
										fontSize: "13px",
										cursor: "pointer"
									},
									children: t("cloud.save")
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => { setPolishPromptText(""); savePolishPrompt(""); },
									style: {
										background: "transparent",
										color: "var(--dsw-alias-label-secondary)",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: "8px",
										padding: "6px 12px",
										fontSize: "12px",
										cursor: "pointer"
									},
									children: t("prompt.reset")
								}),
								promptStatus ? (0, react_jsx_runtime.jsx)("span", {
									style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
									children: promptStatus
								}) : null
							]
						})
					]
				}) : null
			];

			// Cloud-ASR config block: an ordered provider chain (each row is
			// tried in order; on error the host falls through to the next).
			if (engine === "cloud-asr") {
				children.push(
					(0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: "10px",
							padding: "12px",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "10px",
							display: "flex",
							flexDirection: "column",
							gap: "4px"
						},
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginBottom: "6px" },
								children: t("cloud.providerTitle")
							}),
							providers.map((p, i) => (0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", flexDirection: "column", gap: "2px", padding: "8px", border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))", borderRadius: "8px", marginBottom: "6px" },
								children: [
									(0, react_jsx_runtime.jsx)("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												style: { flex: "0 0 24px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: "600" },
												children: "#" + (i + 1)
											}),
											(0, react_jsx_runtime.jsx)("input", {
												type: "text",
												value: p.url,
												placeholder: t("cloud.providerPlaceholderUrl"),
												onChange: (ev) => updateProvider(i, "url", ev.target.value),
												style: {
													flex: "1",
													minWidth: "160px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											}),
											providers.length > 1 ? (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: () => removeProvider(i),
												style: {
													background: "transparent",
													color: "var(--dsw-alias-label-secondary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "4px 10px",
													fontSize: "12px",
													cursor: "pointer",
													flex: "0 0 auto"
												},
												children: t("cloud.removeProvider")
											}) : null
										]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											(0, react_jsx_runtime.jsx)("input", {
												type: "text",
												value: p.model,
												placeholder: t("cloud.providerPlaceholderModel"),
												onChange: (ev) => updateProvider(i, "model", ev.target.value),
												style: {
													flex: "1",
													minWidth: "120px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											}),
											(0, react_jsx_runtime.jsx)("input", {
												type: "password",
												value: p.key,
												placeholder: p.hasKey ? t("cloud.keySet") : t("cloud.key"),
												onChange: (ev) => updateProvider(i, "key", ev.target.value),
												style: {
													flex: "1",
													minWidth: "120px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											})
										]
									})
								]
							}, i)),
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" },
								children: [
									// Hidden at the cap: the host drops rows past MAX_ASR_PROVIDERS, so
									// anything offered beyond it would silently never run.
									providers.length < MAX_ASR_PROVIDERS ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: addProvider,
										style: {
											background: "transparent",
											color: "var(--dsw-alias-label-secondary)",
											border: "1px dashed var(--dsw-alias-border-l2)",
											borderRadius: "8px",
											padding: "6px 12px",
											fontSize: "13px",
											cursor: "pointer"
										},
										children: t("cloud.addProvider")
									}) : null,
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: saveCloud,
										style: {
											background: "var(--dsw-alias-button-info-fill, #5e6ad2)",
											color: "#fff",
											border: "none",
											borderRadius: "8px",
											padding: "6px 14px",
											fontSize: "13px",
											cursor: "pointer"
										},
										children: t("cloud.save")
									}),
									cloudStatus ? (0, react_jsx_runtime.jsx)("span", {
										style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
										children: cloudStatus
									}) : null
								]
							})
						]
					})
				);
			}

			// Hot-word replacement table status (host file $DSH_HOME/voice/hot.txt).
			children.push((0, react_jsx_runtime.jsxs)("div", {
				style: { marginTop: "10px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "4px" },
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginBottom: "2px" },
						children: t("hw.title")
					}),
					hotwordsInfo ? (0, react_jsx_runtime.jsx)("div", {
						style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
						children: hotwordsInfo.error && hotwordsInfo.error !== ""
							? "❌ " + t("hw.error") + "（" + hotwordsInfo.error + "）"
							: (hotwordsInfo.rules > 0 ? "✅ " + String(t("hw.loaded")).replace("{n}", String(hotwordsInfo.rules)) : t("hw.empty"))
					}) : null,
					(0, react_jsx_runtime.jsx)("div", {
						style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
						children: t("hw.note")
					}),
					hotwordsInfo && hotwordsInfo.path ? (0, react_jsx_runtime.jsx)("div", {
						style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", fontFamily: "monospace", wordBreak: "break-all" },
						children: hotwordsInfo.path
					}) : null
				]
			}, "hotwords-block"));

			if (engineWarn) {
				children.push((0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-warning, #d97706)", fontSize: "12px", lineHeight: "18px" },
					children: engineWarn
				}));
			}

			children.push((0, react_jsx_runtime.jsx)("div", {
				style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
				children: t("hint")
			}));

			return (0, react_jsx_runtime.jsx)("div", {
				style: { display: "flex", flexDirection: "column", gap: "2px" },
				children: children
			});
		}

		/**
		 * Microphone button: registered into the composer tool row
		 * (conversation.input.right). Clicking toggles recording; while
		 * mounted it hands the composer's setDraft to the draft channel so
		 * realtime interim results can stream into the composer.
		 */
		function MicrophoneButton({ input, useInput, inputActions, t: injectedT }) {
			const t = typeof injectedT === "function" ? injectedT : (key) => key;
			const [recState, setRecState] = _react.useState({ recording: false, busy: false });
			// DSH 0.1.2+ hands a session-scope slot entry the useInput snapshot
			// selector hook and NOT a resolved input object: reading input.draft
			// there always answered "" and every transcript then REPLACED the user's
			// draft instead of appending to it. Subscribe to the live draft through
			// the hook and keep it in a ref the recorder can read at any time; the
			// legacy input prop stays supported for older shells.
			const useDraft = typeof useInput === "function" ? useInput : () => undefined;
			const liveDraft = useDraft((state) => (state && typeof state.draft === "string" ? state.draft : undefined));
			const draftRef = _react.useRef("");
			draftRef.current = typeof liveDraft === "string" ? liveDraft : (input && typeof input.draft === "string" ? input.draft : "");
			_react.useEffect(() => {
				// Adopt the composer's draft channel (getDraft/setDraft) so the
				// recorder code can write realtime transcripts without touching
				// the DOM. Set on every render so a changed session re-adopts.
				if (inputActions && typeof inputActions.setDraft === "function") {
					setDraftChannel({
						getDraft: () => draftRef.current,
						setDraft: (text) => inputActions.setDraft(text)
					});
				}
				// Poll the REAL module state (wsRecording / recording) — the
				// window cache is only a convenience mirror; reading the module
				// variables directly means the button can never go stale.
				const check = () => {
					setRecState({
						recording: wsRecording === true || recording === true,
						busy: busy === true
					});
				};
				check();
				const timer = setInterval(check, 250);
				return () => {
					clearInterval(timer);
					// Release the channel we adopted — after unmount the
					// recorder must not keep writing to a dead composer.
					setDraftChannel(null);
				};
			}, [inputActions, input]);
			// Tap mode: click toggles. Hold mode: pointerdown starts, pointerup
			// / pointerleave ends — the button mirrors the keyboard gesture.
			const holdMode = readMode() === "hold";
			const activeHotkey = readHotkey();
			// The tooltip keeps the original "Alt"-suffixed string for the
			// default preset and shows the real combo for any other hotkey.
			let label;
			if (recState.recording) label = t("mic.recording");
			else if (recState.busy) label = t("mic.transcribing");
			else if (holdMode) label = t("mic.tooltipHold");
			else if (activeHotkey === "alt") label = t("mic.tooltip");
			else label = t("mic.tooltip").replace(/[（(]Alt[）)]/, "(" + hotkeyDisplay(activeHotkey) + ")");
			const color = recState.recording ? "#e5484d" : "var(--dsw-alias-label-secondary)";
			const pressProps = holdMode ? {
				onPointerDown: (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					beginHold();
				},
				onPointerUp: (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					endHold();
				},
				onPointerLeave: () => endHold()
			} : {
				onClick: (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					toggleRecording();
				}
			};
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title: label,
				"aria-label": label,
				...pressProps,
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: "32px",
					height: "32px",
					padding: "0",
					background: "transparent",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "8px",
					cursor: "pointer",
					color,
					flex: "0 0 auto"
				},
				children: (0, react_jsx_runtime.jsx)("svg", {
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: (0, react_jsx_runtime.jsxs)("g", {
						children: [
							(0, react_jsx_runtime.jsx)("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }),
							(0, react_jsx_runtime.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
							(0, react_jsx_runtime.jsx)("line", { x1: "12", y1: "19", x2: "12", y2: "22" })
						]
					})
				})
			});
		}

		/** Register the composer microphone button (conversation.input.right). */
		const INTENSITY_LEVELS = [
			{ v: "light", label: "轻", color: "#3b82f6", border: "rgba(59,130,246,.5)", bg: "rgba(59,130,246,.08)", desc: "轻度：只删填充词+补标点，不改句式" },
			{ v: "standard", label: "标", color: "#f59e0b", border: "rgba(245,158,11,.5)", bg: "rgba(245,158,11,.08)", desc: "标准：按提示词规则清理（推荐）" },
			{ v: "deep", label: "深", color: "#8b5cf6", border: "rgba(139,92,246,.5)", bg: "rgba(139,92,246,.08)", desc: "深度：可重组句式让表达更紧凑" }
		];

		function readIntensity() {
			try {
				const v = localStorage.getItem("dsh-voice-polish:intensity");
				return (v === "light" || v === "deep") ? v : "standard";
			} catch { return "standard"; }
		}

		function writeIntensity(v) {
			try {
				localStorage.setItem("dsh-voice-polish:intensity", v);
				window.dispatchEvent(new CustomEvent("dsh-voice-polish:intensity-changed", { detail: v }));
			} catch {}
		}

		function readHistory() {
			try {
				const raw = localStorage.getItem("dsh-voice-polish:history") || "[]";
				return JSON.parse(raw);
			} catch { return []; }
		}

		function relTime(ts) {
			const d = Date.now() - ts;
			if (d < 10000) return "刚刚";
			if (d < 60000) return Math.floor(d / 1000) + " 秒前";
			if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
			if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
			const days = Math.floor(d / 86400000);
			if (days < 7) return days + " 天前";
			return new Date(ts).toLocaleDateString();
		}

		function IntensityButton() {
			const [cur, setCur] = _react.useState(readIntensity());
			_react.useEffect(() => {
				const h = (e) => setCur(e.detail || readIntensity());
				window.addEventListener("dsh-voice-polish:intensity-changed", h);
				return () => window.removeEventListener("dsh-voice-polish:intensity-changed", h);
			}, []);
			const idx = INTENSITY_LEVELS.findIndex(l => l.v === cur);
			const info = INTENSITY_LEVELS[idx >= 0 ? idx : 1];
			const cycle = () => {
				const next = INTENSITY_LEVELS[(idx + 1) % INTENSITY_LEVELS.length];
				writeIntensity(next.v);
				setCur(next.v);
			};
			return react_jsx_runtime.jsx("button", {
				type: "button",
				onClick: cycle,
				title: "清理强度：点击切换\n当前：" + info.desc + "\n（点一下循环切到下一档）",
				style: { display: "inline-flex", alignItems: "center", gap: "4px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid " + info.border, background: info.bg, color: info.color, cursor: "pointer", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap", transition: "all .15s ease" },
				children: [
					react_jsx_runtime.jsx("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: info.color, "aria-hidden": true, children: [
						react_jsx_runtime.jsx("path", { d: "M13 2L3 14h7l-1 8 10-12h-7z", key: "bolt" })
					] }),
					info.label
				]
			});
		}

		function registerIntensityButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-polish-intensity",
				order: 34,
				inject: () => ({})
			}, IntensityButton));
		}

		function HistoryButton({ inputActions }) {
			const [open, setOpen] = _react.useState(false);
			const [list, setList] = _react.useState([]);
			const rootRef = _react.useRef(null);

			_react.useEffect(() => {
				const reload = () => setList(readHistory());
				reload();
				window.addEventListener("dsh-voice-polish:history-updated", reload);
				return () => window.removeEventListener("dsh-voice-polish:history-updated", reload);
			}, []);

			_react.useEffect(() => {
				if (!open) return;
				const onDown = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [open]);

			const reuseText = (text) => {
				if (typeof inputActions.setDraft === "function") inputActions.setDraft(text);
				setOpen(false);
			};

			const clearAll = () => {
				try {
					localStorage.removeItem("dsh-voice-polish:history");
					setList([]);
					window.dispatchEvent(new CustomEvent("dsh-voice-polish:history-updated"));
				} catch {}
			};

			const items = list.map((h, idx) => {
				const time = relTime(h.ts);
				return react_jsx_runtime.jsx("div", {
					style: { padding: "8px", borderRadius: "4px", background: "rgba(127,127,127,.05)", border: "1px solid rgba(127,127,127,.15)", display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px" },
					children: [
						react_jsx_runtime.jsx("div", { style: { color: "rgba(127,127,127,.9)", fontSize: "10px" }, children: time + " · " + (h.intensity || "standard") + " · " + ((h.elapsed || 0) + "ms") }, "m"),
						react_jsx_runtime.jsx("div", { style: { color: "rgba(239,68,68,.8)", wordBreak: "break-word", lineHeight: 1.4 }, children: "原: " + (h.original || "").slice(0, 120) + ((h.original || "").length > 120 ? "…" : "") }, "o"),
						react_jsx_runtime.jsx("div", { style: { color: "rgba(16,185,129,.95)", wordBreak: "break-word", lineHeight: 1.4 }, children: "整: " + (h.polished || "").slice(0, 120) + ((h.polished || "").length > 120 ? "…" : "") }, "p"),
						react_jsx_runtime.jsx("div", { style: { display: "flex", gap: "6px", marginTop: "2px" }, children: [
							react_jsx_runtime.jsx("button", {
								type: "button", onClick: () => reuseText(h.original),
								style: { height: "22px", padding: "0 8px", fontSize: "10px", borderRadius: "3px", border: "1px solid rgba(239,68,68,.4)", background: "transparent", color: "rgba(239,68,68,.85)", cursor: "pointer" },
								children: "复用原文"
							}, "ro"),
							react_jsx_runtime.jsx("button", {
								type: "button", onClick: () => reuseText(h.polished),
								style: { height: "22px", padding: "0 8px", fontSize: "10px", borderRadius: "3px", border: "1px solid rgba(16,185,129,.4)", background: "transparent", color: "rgba(16,185,129,.9)", cursor: "pointer" },
								children: "复用整理"
							}, "rp")
						] }, "btns")
					]
				}, "h-" + idx + "-" + h.ts);
			});

			const dropdown = open ? react_jsx_runtime.jsx("div", {
				style: { position: "absolute", right: 0, bottom: "36px", width: "420px", maxHeight: "420px", overflowY: "auto", padding: "10px", borderRadius: "8px", background: "var(--dsh-bg, #1a1a1a)", border: "1px solid rgba(127,127,127,.3)", boxShadow: "0 6px 24px rgba(0,0,0,.3)", zIndex: 1000, display: "flex", flexDirection: "column", gap: "6px" },
				children: [
					react_jsx_runtime.jsx("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "6px", borderBottom: "1px solid rgba(127,127,127,.2)" }, children: [
						react_jsx_runtime.jsx("div", { style: { fontSize: "12px", fontWeight: 600 }, children: "🕐 整理历史（最近 10 条）" }, "th"),
						list.length ? react_jsx_runtime.jsx("button", {
							type: "button", onClick: clearAll,
							style: { height: "22px", padding: "0 8px", fontSize: "10px", borderRadius: "3px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "rgba(127,127,127,.9)", cursor: "pointer" },
							children: "清空"
						}, "clr") : null
					] }, "head"),
					list.length ? react_jsx_runtime.jsx("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: items }, "list")
						: react_jsx_runtime.jsx("div", { style: { padding: "20px", textAlign: "center", color: "rgba(127,127,127,.7)", fontSize: "11px", fontStyle: "italic" }, children: "暂无记录。点整理按钮后会自动记在这里。" }, "empty")
				]
			}) : null;

			return react_jsx_runtime.jsx("div", {
				ref: rootRef,
				style: { position: "relative", display: "inline-flex", alignItems: "center" },
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						onClick: () => setOpen(!open),
						title: "整理历史（最近 10 条，本地保存，点开可复用）",
						style: { display: "inline-flex", alignItems: "center", gap: "4px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid " + (open ? "rgba(127,127,127,.6)" : "rgba(127,127,127,.3)"), background: open ? "rgba(127,127,127,.1)" : "transparent", color: "inherit", cursor: "pointer", fontSize: "12px", whiteSpace: "nowrap" },
						children: [
							react_jsx_runtime.jsx("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
								react_jsx_runtime.jsx("circle", { cx: 12, cy: 12, r: 10, key: "c" }),
								react_jsx_runtime.jsx("path", { d: "M12 6v6l4 2", key: "h" })
							] }, "ico"),
							list.length ? String(list.length) : ""
						]
					}, "btn"),
					dropdown
				]
			});
		}

		function registerHistoryButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-polish-history",
				order: 37,
				inject: () => ({})
			}, HistoryButton));
		}

		function PolishButton({ input, useInput, inputActions }) {
			const [busy, setBusy] = _react.useState(false);
			const [flash, setFlash] = _react.useState("");
			const [canUndo, setCanUndo] = _react.useState(false);
			const undoRef = _react.useRef("");
			const useDraft = typeof useInput === "function" ? useInput : () => undefined;
			const liveDraft = useDraft((state) => (state && typeof state.draft === "string" ? state.draft : ""));
			const draft = typeof liveDraft === "string" ? liveDraft : (input && typeof input.draft === "string" ? input.draft : "");

			const readIntensity = () => {
				try {
					const v = localStorage.getItem("dsh-voice-polish:intensity");
					return (v === "light" || v === "deep") ? v : "standard";
				} catch { return "standard"; }
			};

			const pushHistory = (entry) => {
				try {
					const raw = localStorage.getItem("dsh-voice-polish:history") || "[]";
					const arr = JSON.parse(raw);
					arr.unshift(entry);
					while (arr.length > 10) arr.pop();
					localStorage.setItem("dsh-voice-polish:history", JSON.stringify(arr));
					// 更新累计 stats
					const statsRaw = localStorage.getItem("dsh-voice-polish:stats") || "{}";
					const stats = JSON.parse(statsRaw);
					const today = new Date().toISOString().slice(0, 10);
					stats.today = stats.today || {};
					stats.today[today] = (stats.today[today] || 0) + 1;
					stats.totalRuns = (stats.totalRuns || 0) + 1;
					stats.totalInputChars = (stats.totalInputChars || 0) + (entry.original || "").length;
					stats.totalOutputChars = (stats.totalOutputChars || 0) + (entry.polished || "").length;
					stats.totalElapsed = (stats.totalElapsed || 0) + (entry.elapsed || 0);
					localStorage.setItem("dsh-voice-polish:stats", JSON.stringify(stats));
					window.dispatchEvent(new CustomEvent("dsh-voice-polish:history-updated"));
					window.dispatchEvent(new CustomEvent("dsh-voice-polish:stats-updated"));
				} catch {}
			};

			const quickAddHotword = async () => {
				const line = window.prompt("加一条热词，格式：正确词=错词1|错词2\n例如：B站=避展|必站\n（支持正则：/模式/替换/flags）");
				if (!line || !line.trim()) return;
				try {
					const r = await hostCall({ action: "add-hotword", line: line.trim() });
					if (r && r.ok) { setFlash("hwOk"); setTimeout(() => setFlash(""), 2500); }
					else { window.alert("热词保存失败：" + ((r && r.error) || "unknown")); }
				} catch (e) { window.alert("热词保存出错：" + (e && e.message)); }
			};

			const doUndo = () => {
				if (!canUndo || !undoRef.current) return;
				if (typeof inputActions.setDraft === "function") inputActions.setDraft(undoRef.current);
				setCanUndo(false);
				setFlash("undone");
				setTimeout(() => setFlash(""), 2000);
			};

			const onClick = async (ev) => {
				if (ev && ev.shiftKey) { quickAddHotword(); return; }
				if (ev && ev.altKey && canUndo) { doUndo(); return; }
				const text = (draft || "").trim();
				if (!text || busy) return;
				// Ctrl+点：跳过 AI，仅应用热词+Snippets（本地离线）
				if (ev && ev.ctrlKey) {
					setBusy(true); setFlash(""); setCanUndo(false);
					try {
						const hw = await hostCall({ action: "get-hotwords" });
						const sn = await hostCall({ action: "get-snippets" });
						let out = text;
						if (sn && sn.ok) {
							const snLines = (sn.text || "").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
							for (const line of snLines) {
								const eq = line.indexOf("=");
								if (eq <= 0) continue;
								const trig = line.slice(0, eq).trim();
								const exp = line.slice(eq + 1);
								try { out = out.replace(new RegExp("(^|[\\s\\p{P}])" + trig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[\\s\\p{P}]|$)", "gu"), (m, pre) => (pre || "") + exp); } catch {}
							}
						}
						if (hw && hw.ok) {
							const hwLines = (hw.text || "").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
							for (const line of hwLines) {
								const eq = line.indexOf("=");
								if (eq <= 0) continue;
								const correct = line.slice(0, eq).trim();
								const wrongs = line.slice(eq + 1).split("|").map(s => s.trim()).filter(Boolean);
								for (const w of wrongs) {
									try { out = out.split(w).join(correct); } catch {}
								}
							}
						}
						if (out !== text && typeof inputActions.setDraft === "function") {
							undoRef.current = text;
							inputActions.setDraft(out);
							setFlash("ok"); setCanUndo(true);
							setTimeout(() => setCanUndo(false), 15000);
						} else { setFlash("keep"); }
					} catch (e) { setFlash("err"); }
					finally { setBusy(false); setTimeout(() => setFlash(""), 2500); }
					return;
				}
				const configured = readPolishModel();
				if (!configured || !configured.provider || !configured.model) {
					setFlash("needConfig");
					setTimeout(() => setFlash(""), 3500);
					return;
				}
				const intensity = readIntensity();
				setBusy(true); setFlash(""); setCanUndo(false);
				try {
					console.log("[voice-polish] 整理:", { len: text.length, provider: configured.provider, model: configured.model, intensity });
					const t0 = Date.now();
					const res = await hostCall({ action: "polish", text, provider: configured.provider, model: configured.model, intensity });
					const elapsed = Date.now() - t0;
					const okReal = res && res.ok === true && typeof res.text === "string" && res.text.trim() !== "";
					const out = okReal ? res.text : text;
					if (!okReal && res && res.error) {
						window.__dshVoicePolishLastError = (res.error && res.error.message) || JSON.stringify(res.error);
					} else if (okReal) {
						window.__dshVoicePolishLastError = null;
					}
					console.log("[voice-polish] 结果:", { changed: out !== text, outLen: out && out.length, ms: elapsed });
					if (out && out !== text && typeof inputActions.setDraft === "function") {
						undoRef.current = text;
						inputActions.setDraft(out);
						setFlash("ok");
						setCanUndo(true);
						pushHistory({ ts: Date.now(), original: text, polished: out, intensity, elapsed });
						setTimeout(() => setCanUndo(false), 15000);
					} else if (out === text) { setFlash("keep"); }
					else { setFlash("err"); }
				} catch (e) {
					console.error("[voice-polish] 失败:", e);
					setFlash("err");
				}
				finally { setBusy(false); setTimeout(() => setFlash(""), 2500); }
			};

			const isErr = flash === "err";
			const isOk = flash === "ok" || flash === "hwOk" || flash === "undone";
			const isKeep = flash === "keep";
			const isNeedConfig = flash === "needConfig";
			const label = busy ? "整理中…"
				: flash === "hwOk" ? "已加词"
				: flash === "undone" ? "已还原"
				: flash === "ok" ? "已整理"
				: isErr ? "失败"
				: isKeep ? "无变化"
				: isNeedConfig ? "请在设置选模型"
				: canUndo ? "整理（Alt 还原）"
				: "整理";
			const iconColor = isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : (canUndo ? "#8b5cf6" : "#f59e0b"));
			const borderColor = isErr || isNeedConfig ? "rgba(239,68,68,.5)" : (isOk ? "rgba(16,185,129,.5)" : (canUndo ? "rgba(139,92,246,.5)" : "rgba(245,158,11,.4)"));
			const bgColor = isErr || isNeedConfig ? "rgba(239,68,68,.08)" : (isOk ? "rgba(16,185,129,.08)" : "transparent");
			return react_jsx_runtime.jsx("button", {
				type: "button",
				title: isErr && window.__dshVoicePolishLastError
					? ("最近失败：" + String(window.__dshVoicePolishLastError).slice(0, 200) + "\n\n点击 = AI 整理\nCtrl+点击 = 仅本地热词+Snippets（跳过 AI）\nAlt+点击 = 还原（15 秒内）\nShift+点击 = 加热词")
					: "点击 = AI 整理\nCtrl+点击 = 仅本地热词+Snippets（跳过 AI，纯离线）\nAlt+点击 = 还原到整理前（成功后 15 秒内）\nShift+点击 = 快速加热词",
				onClick,
				disabled: busy || !draft,
				style: { display: "inline-flex", alignItems: "center", gap: "5px", height: "28px", padding: "0 10px", borderRadius: "6px", border: "1px solid " + borderColor, background: bgColor, color: isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : "inherit"), cursor: busy || !draft ? "default" : "pointer", fontSize: "12px", opacity: busy || !draft ? 0.5 : 1, whiteSpace: "nowrap", transition: "all .15s ease" },
				children: [
					react_jsx_runtime.jsx("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: iconColor, strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
						react_jsx_runtime.jsx("path", { d: "M9.9 15.5a2 2 0 0 0-1.4-1.4l-6-1.6a.5.5 0 0 1 0-1l6-1.6a2 2 0 0 0 1.4-1.4l1.6-6a.5.5 0 0 1 1 0l1.6 6a2 2 0 0 0 1.4 1.4l6 1.6a.5.5 0 0 1 0 1l-6 1.6a2 2 0 0 0-1.4 1.4l-1.6 6a.5.5 0 0 1-1 0z", key: "s1" }),
						react_jsx_runtime.jsx("path", { d: "M20 3v4", key: "s2" }),
						react_jsx_runtime.jsx("path", { d: "M22 5h-4", key: "s3" })
					] }),
					label
				]
			});
		}
		function PolishLabRow() {
			const [testIn, setTestIn] = _react.useState("");
			const [testOut, setTestOut] = _react.useState("");
			const [testing, setTesting] = _react.useState(false);
			const [hwText, setHwText] = _react.useState("");
			const [hwLoaded, setHwLoaded] = _react.useState(false);
			const [hwStatus, setHwStatus] = _react.useState("");
			const [presetMsg, setPresetMsg] = _react.useState("");
			const [intensity, setIntensityState] = _react.useState("standard");
			const [history, setHistory] = _react.useState([]);
			const [diag, setDiag] = _react.useState(null);
			const [diagRunning, setDiagRunning] = _react.useState(false);

			_react.useEffect(() => {
				try {
					const v = localStorage.getItem("dsh-voice-polish:intensity");
					if (v === "light" || v === "deep" || v === "standard") setIntensityState(v);
				} catch {}
				const loadHistory = () => {
					try {
						const raw = localStorage.getItem("dsh-voice-polish:history") || "[]";
						setHistory(JSON.parse(raw));
					} catch { setHistory([]); }
				};
				loadHistory();
				window.addEventListener("dsh-voice-polish:history-updated", loadHistory);
				return () => window.removeEventListener("dsh-voice-polish:history-updated", loadHistory);
			}, []);

			_react.useEffect(() => {
				if (hwLoaded) return;
				hostCall({ action: "get-hotwords" }).then((r) => {
					if (r && r.ok) setHwText(r.text || "");
					setHwLoaded(true);
				}).catch(() => setHwLoaded(true));
			}, [hwLoaded]);

			const changeIntensity = (v) => {
				setIntensityState(v);
				try { localStorage.setItem("dsh-voice-polish:intensity", v); } catch {}
			};

			const runTest = async () => {
				const text = testIn.trim();
				if (!text || testing) return;
				const cfg = readPolishModel();
				if (!cfg || !cfg.provider || !cfg.model) {
					setTestOut("⚠️ 请先在上方「润色模型」选一个");
					return;
				}
				setTesting(true); setTestOut("…整理中");
				try {
					const r = await hostCall({ action: "polish", text, provider: cfg.provider, model: cfg.model, intensity });
					const out = (r && r.ok && typeof r.text === "string" && r.text.trim()) ? r.text : text;
					setTestOut(out);
				} catch (e) {
					setTestOut("❌ " + (e && e.message || "失败"));
				} finally { setTesting(false); }
			};

			const saveHw = async () => {
				try {
					const r = await hostCall({ action: "save-hotwords", content: hwText });
					if (r && r.ok) setHwStatus("✓ 已保存 " + (r.count || 0) + " 条规则");
					else setHwStatus("保存失败：" + ((r && r.error) || "unknown"));
				} catch (e) { setHwStatus("错误：" + (e && e.message || e)); }
				setTimeout(() => setHwStatus(""), 3000);
			};

			const clearHistory = () => {
				try {
					localStorage.removeItem("dsh-voice-polish:history");
					setHistory([]);
				} catch {}
			};

			const runDiag = async () => {
				setDiagRunning(true); setDiag(null);
				const r = { gateway: null, models: null, hotwords: null, polish: null };
				const cfg = readPolishModel();
				try {
					const models = await hostCall({ action: "list-models" });
					r.gateway = models ? "✓ 响应正常" : "✗ 无响应";
					if (models && models.ok && Array.isArray(models.value)) {
						r.models = "✓ " + models.value.length + " 个 provider 可用";
					} else r.models = "⚠ 读不到 provider 列表";
				} catch (e) { r.gateway = "✗ " + (e && e.message); r.models = "—"; }
				try {
					const hw = await hostCall({ action: "get-hotwords" });
					if (hw && hw.ok) {
						const n = (hw.text || "").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#")).length;
						r.hotwords = "✓ " + n + " 条规则";
					} else r.hotwords = "⚠ 未加载";
				} catch (e) { r.hotwords = "✗ " + (e && e.message); }
				if (cfg && cfg.provider && cfg.model) {
					try {
						const p = await hostCall({ action: "polish", text: "嗯 测试一下。", provider: cfg.provider, model: cfg.model, intensity: "light" });
						if (p && p.ok && typeof p.text === "string") r.polish = "✓ " + cfg.provider + "/" + cfg.model + " 可调用 → \"" + p.text.slice(0, 20) + "\"";
						else r.polish = "✗ " + ((p && p.error && p.error.message) || "调用失败");
					} catch (e) { r.polish = "✗ " + (e && e.message); }
				} else r.polish = "⚠ 未选模型，跳过调用测试";
				setDiag(r);
				setDiagRunning(false);
			};

			const PRESETS = {
				"口语保留": "删重复起头和严重冗余；补标点；保留轻微口语感和语气词（吧/呢/哈/啊）；不改意思不扩写。",
				"正式商务": "删口头禅与冗余；补标准标点；口语化短语改书面语；保留专有名词原样；不加敬语不扩写不加修辞。",
				"技术文档": "删口头禅；保留所有英文、代码、路径、命令、API 名、版本号原样；补标点拆长句；术语精确不改同义词；不加解释。",
				"精简纪要": "删一切填充、重复、口头禅；只保留事实陈述；补标点；按要点拆行；不加解释。",
			"🎯 智能纠错": "ASR 识别常把音近字搞错或丢字。基于上下文和中文表达习惯主动推断用户真实意图并修正：同音/近音错字放胆改（的得地、再在、作做、几份级、他她它）；读起来明显不通的短语根据前后文重构最可能的原意；语气词和残句如果显然是识别截断，补成完整表达。保留专有名词和英文原文不动。如果某处确实判断不出，才保留原样。"
			};
			const copyPreset = (name) => {
				const text = PRESETS[name];
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(() => {
						setPresetMsg("✓ 已复制「" + name + "」到剪贴板，粘贴到上方「润色提示词」框");
						setTimeout(() => setPresetMsg(""), 4000);
					});
				} else { window.prompt("复制下面的提示词：", text); }
			};
			const presetBtns = Object.keys(PRESETS).map((name) =>
				react_jsx_runtime.jsx("button", {
					type: "button",
					onClick: () => copyPreset(name),
					title: PRESETS[name],
					style: { height: "26px", padding: "0 10px", fontSize: "11px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", cursor: "pointer" },
					children: name
				}, name)
			);

			const intensityOptions = [
				{ v: "light", t: "轻度", d: "只删填充词和补标点，不改用词" },
				{ v: "standard", t: "标准", d: "默认：按提示词规则清理（推荐）" },
				{ v: "deep", t: "深度", d: "可以重组句式让表达更紧凑" }
			];
			const intensityBtns = intensityOptions.map((opt) =>
				react_jsx_runtime.jsx("button", {
					type: "button",
					onClick: () => changeIntensity(opt.v),
					title: opt.d,
					style: { height: "28px", padding: "0 12px", fontSize: "12px", borderRadius: "4px", border: "1px solid " + (intensity === opt.v ? "#f59e0b" : "rgba(127,127,127,.3)"), background: intensity === opt.v ? "rgba(245,158,11,.12)" : "transparent", color: intensity === opt.v ? "#f59e0b" : "inherit", fontWeight: intensity === opt.v ? 600 : 400, cursor: "pointer" },
					children: opt.t
				}, opt.v)
			);

			const historyItems = history.slice(0, 10).map((h, idx) => {
				const time = new Date(h.ts).toLocaleTimeString();
				return react_jsx_runtime.jsx("div", {
					style: { padding: "8px 10px", borderRadius: "4px", background: "rgba(127,127,127,.05)", border: "1px solid rgba(127,127,127,.15)", fontSize: "11px" },
					children: [
						react_jsx_runtime.jsx("div", { style: { display: "flex", gap: "8px", color: "rgba(127,127,127,.9)", fontSize: "10px", marginBottom: "4px" }, children: time + " · " + (h.intensity || "standard") + " · " + ((h.elapsed || 0) + "ms") }, "meta-" + idx),
						react_jsx_runtime.jsx("div", { style: { color: "rgba(239,68,68,.75)", marginBottom: "3px", wordBreak: "break-word" }, children: "原: " + (h.original || "").slice(0, 100) }, "o-" + idx),
						react_jsx_runtime.jsx("div", { style: { color: "rgba(16,185,129,.9)", wordBreak: "break-word" }, children: "整: " + (h.polished || "").slice(0, 100) }, "p-" + idx)
					]
				}, "h-" + idx + "-" + h.ts);
			});

			const diagItems = diag ? [
				react_jsx_runtime.jsx("div", { children: "宿主路由：" + diag.gateway }, "d1"),
				react_jsx_runtime.jsx("div", { children: "Provider：" + diag.models }, "d2"),
				react_jsx_runtime.jsx("div", { children: "热词表：" + diag.hotwords }, "d3"),
				react_jsx_runtime.jsx("div", { children: "模型调用：" + diag.polish }, "d4")
			] : null;

			return react_jsx_runtime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "20px", padding: "16px 0", borderTop: "1px solid rgba(127,127,127,.2)", marginTop: "8px" },
				children: [
					react_jsx_runtime.jsx("div", {
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px", marginBottom: "4px" }, children: "🧪 测试整理（不写回输入框）" }, "t-h"),
							react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "6px" }, children: "粘贴一段口语文本，试试当前模型 + 提示词 + 热词 + 强度的组合效果" }, "t-s"),
							react_jsx_runtime.jsx("textarea", {
								value: testIn,
								onChange: (e) => setTestIn(e.target.value),
								placeholder: "例如：嗯 那个 我今天 想让你 帮我查一下 问号",
								rows: 3,
								style: { width: "100%", resize: "vertical", fontSize: "12px", padding: "8px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", fontFamily: "inherit", boxSizing: "border-box" }
							}, "t-in"),
							react_jsx_runtime.jsx("div", { style: { marginTop: "6px" }, children: react_jsx_runtime.jsx("button", {
								type: "button", onClick: runTest, disabled: testing || !testIn.trim(),
								style: { height: "28px", padding: "0 14px", fontSize: "12px", borderRadius: "4px", border: "1px solid #f59e0b", background: "rgba(245,158,11,.1)", color: "#f59e0b", cursor: testing || !testIn.trim() ? "default" : "pointer", opacity: testing || !testIn.trim() ? 0.5 : 1 },
								children: testing ? "测试中…" : "✦ 测试整理"
							}) }, "t-btn"),
							testOut ? react_jsx_runtime.jsx("div", {
								style: { marginTop: "8px", padding: "10px", borderRadius: "4px", background: "rgba(16,185,129,.08)", border: "1px solid rgba(16,185,129,.25)", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
								children: testOut
							}, "t-out") : null
						]
					}, "test"),

					react_jsx_runtime.jsx("div", {
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px", marginBottom: "4px" }, children: "📝 语气预设模板" }, "p-h"),
							react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "6px" }, children: "点一下复制，粘贴到上方「润色提示词」切换风格（鼠标悬停看预览）" }, "p-s"),
							react_jsx_runtime.jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" }, children: presetBtns }, "p-row"),
							presetMsg ? react_jsx_runtime.jsx("div", { style: { marginTop: "6px", fontSize: "11px", color: "#10b981" }, children: presetMsg }, "p-msg") : null
						]
					}, "preset"),

					react_jsx_runtime.jsx("div", {
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px", marginBottom: "4px" }, children: "📋 热词替换表（直接编辑 hot.txt）" }, "h-h"),
							react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "6px" }, children: "每行一条，格式 正确词=错词1|错词2；保存后下次「整理」立即生效。Shift + 点整理按钮也可随手加。" }, "h-s"),
							react_jsx_runtime.jsx("textarea", {
								value: hwText,
								onChange: (e) => setHwText(e.target.value),
								placeholder: "# 每行一条\nB站=避展|必站\n恋活=炼活|联活",
								rows: 8,
								style: { width: "100%", resize: "vertical", fontSize: "12px", padding: "8px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", fontFamily: "monospace", boxSizing: "border-box" }
							}, "h-ta"),
							react_jsx_runtime.jsx("div", { style: { marginTop: "6px", display: "flex", gap: "10px", alignItems: "center" }, children: [
								react_jsx_runtime.jsx("button", {
									type: "button", onClick: saveHw,
									style: { height: "28px", padding: "0 14px", fontSize: "12px", borderRadius: "4px", border: "1px solid #10b981", background: "rgba(16,185,129,.1)", color: "#10b981", cursor: "pointer" },
									children: "💾 保存热词"
								}, "h-save"),
								hwStatus ? react_jsx_runtime.jsx("span", { style: { fontSize: "11px", color: "rgba(127,127,127,.9)" }, children: hwStatus }, "h-st") : null
							] }, "h-row")
						]
					}, "hw"),

					react_jsx_runtime.jsx(function SnippetsRow() {
						const [snText, setSnText] = _react.useState("");
						const [snLoaded, setSnLoaded] = _react.useState(false);
						const [snStatus, setSnStatus] = _react.useState("");
						_react.useEffect(() => {
							if (snLoaded) return;
							hostCall({ action: "get-snippets" }).then((r) => {
								if (r && r.ok) setSnText(r.text || "");
								setSnLoaded(true);
							}).catch(() => setSnLoaded(true));
						}, [snLoaded]);
						const saveSn = async () => {
							try {
								const r = await hostCall({ action: "save-snippets", content: snText });
								if (r && r.ok) setSnStatus("✓ 已保存 " + (r.count || 0) + " 条短语");
								else setSnStatus("保存失败：" + ((r && r.error) || "unknown"));
							} catch (e) { setSnStatus("错误：" + (e && e.message || e)); }
							setTimeout(() => setSnStatus(""), 3000);
						};
						return react_jsx_runtime.jsx("div", {
							children: [
								react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px", marginBottom: "4px" }, children: "⚡ Snippets 短语扩展" }, "s-h"),
								react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "6px" }, children: "说一个短触发词 → 自动展开成完整内容。整理前应用，不占 token。格式：触发词=完整内容（支持多行）。例：签名=此致敬礼，张三 / 邮箱=zhang@example.com" }, "s-s"),
								react_jsx_runtime.jsx("textarea", {
									value: snText,
									onChange: (e) => setSnText(e.target.value),
									placeholder: "# 每行一条\n签名=此致敬礼，张三 2026-11-02\n邮箱=zhang@example.com\n地址=北京市朝阳区某某路 123 号",
									rows: 6,
									style: { width: "100%", resize: "vertical", fontSize: "12px", padding: "8px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", fontFamily: "monospace", boxSizing: "border-box" }
								}, "s-ta"),
								react_jsx_runtime.jsx("div", { style: { marginTop: "6px", display: "flex", gap: "10px", alignItems: "center" }, children: [
									react_jsx_runtime.jsx("button", {
										type: "button", onClick: saveSn,
										style: { height: "28px", padding: "0 14px", fontSize: "12px", borderRadius: "4px", border: "1px solid #8b5cf6", background: "rgba(139,92,246,.1)", color: "#8b5cf6", cursor: "pointer" },
										children: "💾 保存 Snippets"
									}, "s-save"),
									snStatus ? react_jsx_runtime.jsx("span", { style: { fontSize: "11px", color: "rgba(127,127,127,.9)" }, children: snStatus }, "s-st") : null
								] }, "s-row")
							]
						});
					}, {}, "snippets"),


					react_jsx_runtime.jsx(function Insights() {
						const [stats, setStats] = _react.useState(null);
						_react.useEffect(() => {
							const load = () => {
								try {
									const raw = localStorage.getItem("dsh-voice-polish:stats") || "{}";
									setStats(JSON.parse(raw));
								} catch { setStats({}); }
							};
							load();
							window.addEventListener("dsh-voice-polish:stats-updated", load);
							return () => window.removeEventListener("dsh-voice-polish:stats-updated", load);
						}, []);
						const clearStats = () => {
							try { localStorage.removeItem("dsh-voice-polish:stats"); setStats({}); } catch {}
						};
						const s = stats || {};
						const today = new Date().toISOString().slice(0, 10);
						const todayCount = (s.today && s.today[today]) || 0;
						const runs = s.totalRuns || 0;
						const inChars = s.totalInputChars || 0;
						const outChars = s.totalOutputChars || 0;
						const savedChars = Math.max(0, inChars - outChars);
						const avgMs = runs ? Math.round((s.totalElapsed || 0) / runs) : 0;
						const cards = [
							{ k: "今日", v: String(todayCount), u: "次" },
							{ k: "累计", v: String(runs), u: "次" },
							{ k: "净删", v: String(savedChars), u: "字" },
							{ k: "平均", v: String(avgMs), u: "ms" }
						];
						return react_jsx_runtime.jsx("div", {
							children: [
								react_jsx_runtime.jsx("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }, children: [
									react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px" }, children: "📊 使用洞察" }, "ih"),
									runs ? react_jsx_runtime.jsx("button", {
										type: "button", onClick: clearStats,
										style: { height: "22px", padding: "0 8px", fontSize: "10px", borderRadius: "3px", border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "rgba(127,127,127,.9)", cursor: "pointer" },
										children: "清零"
									}, "ic") : null
								] }, "ihead"),
								react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "8px" }, children: "本地统计，不上传。'净删'=输入字数-输出字数，正值代表整理后变简洁。" }, "isub"),
								react_jsx_runtime.jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }, children: cards.map((c) =>
									react_jsx_runtime.jsx("div", {
										style: { padding: "10px 8px", borderRadius: "6px", background: "rgba(127,127,127,.06)", border: "1px solid rgba(127,127,127,.15)", textAlign: "center" },
										children: [
											react_jsx_runtime.jsx("div", { style: { fontSize: "10px", color: "rgba(127,127,127,.8)", marginBottom: "2px" }, children: c.k }, "k"),
											react_jsx_runtime.jsx("span", { style: { fontSize: "18px", fontWeight: 700, color: "#f59e0b" }, children: c.v }, "v"),
											react_jsx_runtime.jsx("span", { style: { fontSize: "11px", color: "rgba(127,127,127,.7)", marginLeft: "3px" }, children: c.u }, "u")
										]
									}, c.k)
								) }, "igrid")
							]
						});
					}, {}, "insights"),

										react_jsx_runtime.jsx("div", {
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: "13px", marginBottom: "4px" }, children: "🔧 自检" }, "d-h"),
							react_jsx_runtime.jsx("div", { style: { fontSize: "11px", color: "rgba(127,127,127,.8)", marginBottom: "6px" }, children: "一键检测宿主路由、provider、热词、模型调用是否正常；排错时先跑这个" }, "d-s"),
							react_jsx_runtime.jsx("button", {
								type: "button", onClick: runDiag, disabled: diagRunning,
								style: { height: "28px", padding: "0 14px", fontSize: "12px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", cursor: diagRunning ? "default" : "pointer", opacity: diagRunning ? 0.5 : 1 },
								children: diagRunning ? "检测中…" : "▶ 运行自检"
							}, "d-btn"),
							diag ? react_jsx_runtime.jsx("div", {
								style: { marginTop: "8px", padding: "10px", borderRadius: "4px", background: "rgba(127,127,127,.05)", border: "1px solid rgba(127,127,127,.2)", fontSize: "12px", display: "flex", flexDirection: "column", gap: "4px" },
								children: diagItems
							}, "d-out") : null
						]
					}, "diag")
				]
			});
		}

		function registerPolishLab(ctx) {
			ctx.slots.inject("settings.voiceScribe.item", () => ctx.slots.register({
				name: "settings.voiceScribe.item",
				id: "dsh-voice-polish-lab",
				order: 20,
				locale: SETTINGS_NS
			}, PolishLabRow));
		}

		function EnrichButton({ input, useInput, inputActions }) {
			const [busy, setBusy] = _react.useState(false);
			const [flash, setFlash] = _react.useState("");
			const useDraft = typeof useInput === "function" ? useInput : () => undefined;
			const liveDraft = useDraft((state) => (state && typeof state.draft === "string" ? state.draft : ""));
			const draft = typeof liveDraft === "string" ? liveDraft : (input && typeof input.draft === "string" ? input.draft : "");

			const onClick = async () => {
				const text = (draft || "").trim();
				if (!text || busy) return;
				const configured = readPolishModel();
				if (!configured || !configured.provider || !configured.model) {
					setFlash("needConfig");
					setTimeout(() => setFlash(""), 3500);
					return;
				}
				setBusy(true); setFlash("");
				try {
					console.log("[voice-polish] 润色:", { len: text.length, provider: configured.provider, model: configured.model });
					const t0 = Date.now();
					const res = await hostCall({ action: "enhance", text, provider: configured.provider, model: configured.model });
					const elapsed = Date.now() - t0;
					const okReal = res && res.ok === true && typeof res.text === "string" && res.text.trim() !== "";
					const out = okReal ? res.text : text;
					console.log("[voice-polish] 润色结果:", { changed: out !== text, outLen: out && out.length, ms: elapsed });
					if (okReal && out !== text && typeof inputActions.setDraft === "function") {
						inputActions.setDraft(out);
						setFlash("ok");
						try {
							const raw = localStorage.getItem("dsh-voice-polish:history") || "[]";
							const arr = JSON.parse(raw);
							arr.unshift({ ts: Date.now(), original: text, polished: out, intensity: "enhance", elapsed });
							while (arr.length > 10) arr.pop();
							localStorage.setItem("dsh-voice-polish:history", JSON.stringify(arr));
							window.dispatchEvent(new CustomEvent("dsh-voice-polish:history-updated"));
							window.dispatchEvent(new CustomEvent("dsh-voice-polish:stats-updated"));
						} catch {}
					} else if (out === text) {
						setFlash("keep");
					} else {
						setFlash("err");
						if (res && res.error) window.__dshVoicePolishLastError = (res.error && res.error.message) || JSON.stringify(res.error);
					}
				} catch (e) {
					console.error("[voice-polish] 润色失败:", e);
					setFlash("err");
				}
				finally { setBusy(false); setTimeout(() => setFlash(""), 2500); }
			};

			const isErr = flash === "err";
			const isOk = flash === "ok";
			const isKeep = flash === "keep";
			const isNeedConfig = flash === "needConfig";
			const label = busy ? "润色中…" : isOk ? "已润色" : isErr ? "失败" : isKeep ? "无变化" : isNeedConfig ? "请选模型" : "润色";
			const iconColor = isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : "#8b5cf6");
			const borderColor = isErr || isNeedConfig ? "rgba(239,68,68,.5)" : (isOk ? "rgba(16,185,129,.5)" : "rgba(139,92,246,.45)");
			const bgColor = isErr || isNeedConfig ? "rgba(239,68,68,.08)" : (isOk ? "rgba(16,185,129,.08)" : "transparent");
			return react_jsx_runtime.jsx("button", {
				type: "button",
				title: "AI 润色：把当前文本扩展为结构化、具体的 AI 提示词\n（先用 ✦ 整理清口语，再按 ✨ 润色，效果最好）",
				onClick,
				disabled: busy || !draft,
				style: { display: "inline-flex", alignItems: "center", gap: "5px", height: "28px", padding: "0 10px", borderRadius: "6px", border: "1px solid " + borderColor, background: bgColor, color: isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : "inherit"), cursor: busy || !draft ? "default" : "pointer", fontSize: "12px", opacity: busy || !draft ? 0.5 : 1, whiteSpace: "nowrap", transition: "all .15s ease" },
				children: [
					react_jsx_runtime.jsx("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: iconColor, strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
						react_jsx_runtime.jsx("path", { d: "M12 2l2.4 7.4h7.6l-6.2 4.5 2.4 7.4L12 16.9l-6.2 4.4 2.4-7.4L2 9.4h7.6z", key: "star" })
					] }),
					label
				]
			});
		}

		function TranslateButton({ input, useInput, inputActions }) {
			const LANGS = [{ v: "en", t: "EN" }, { v: "zh", t: "ZH" }, { v: "ja", t: "JA" }, { v: "ko", t: "KO" }];
			const readLang = () => {
				try {
					const v = localStorage.getItem("dsh-voice-polish:translate-target");
					return LANGS.find(x => x.v === v) ? v : "en";
				} catch { return "en"; }
			};
			const [targetLang, setTargetLang] = _react.useState(readLang());
			const [busy, setBusy] = _react.useState(false);
			const [flash, setFlash] = _react.useState("");
			const useDraft = typeof useInput === "function" ? useInput : () => undefined;
			const liveDraft = useDraft((s) => (s && typeof s.draft === "string" ? s.draft : ""));
			const draft = typeof liveDraft === "string" ? liveDraft : (input && typeof input.draft === "string" ? input.draft : "");

			const cycleLang = () => {
				const idx = LANGS.findIndex(x => x.v === targetLang);
				const next = LANGS[(idx + 1) % LANGS.length].v;
				try { localStorage.setItem("dsh-voice-polish:translate-target", next); } catch {}
				setTargetLang(next);
				setFlash("switched");
				setTimeout(() => setFlash(""), 1500);
			};

			const onClick = async (ev) => {
				if (ev && ev.shiftKey) { cycleLang(); return; }
				const text = (draft || "").trim();
				if (!text || busy) return;
				const cfg = readPolishModel();
				if (!cfg || !cfg.provider || !cfg.model) {
					setFlash("needConfig");
					setTimeout(() => setFlash(""), 3500);
					return;
				}
				setBusy(true); setFlash("");
				try {
					console.log("[voice-polish] 翻译:", { len: text.length, to: targetLang });
					const t0 = Date.now();
					const r = await hostCall({ action: "translate", text, provider: cfg.provider, model: cfg.model, targetLang });
					const elapsed = Date.now() - t0;
					const okReal = r && r.ok === true && typeof r.text === "string" && r.text.trim() !== "";
					const out = okReal ? r.text : text;
					if (okReal && out !== text && typeof inputActions.setDraft === "function") {
						inputActions.setDraft(out);
						setFlash("ok");
						try {
							const raw = localStorage.getItem("dsh-voice-polish:history") || "[]";
							const arr = JSON.parse(raw);
							arr.unshift({ ts: Date.now(), original: text, polished: out, intensity: "translate:" + targetLang, elapsed });
							while (arr.length > 10) arr.pop();
							localStorage.setItem("dsh-voice-polish:history", JSON.stringify(arr));
							window.dispatchEvent(new CustomEvent("dsh-voice-polish:history-updated"));
						} catch {}
					} else if (out === text) {
						setFlash("keep");
					} else {
						setFlash("err");
					}
				} catch (e) {
					console.error("[voice-polish] 翻译失败:", e);
					setFlash("err");
				}
				finally { setBusy(false); setTimeout(() => setFlash(""), 2500); }
			};

			const info = LANGS.find(x => x.v === targetLang) || LANGS[0];
			const isErr = flash === "err";
			const isOk = flash === "ok";
			const isKeep = flash === "keep";
			const isNeedConfig = flash === "needConfig";
			const isSwitched = flash === "switched";
			const label = busy ? "翻译中…" : isOk ? "✓" : isErr ? "✗" : isKeep ? "=" : isNeedConfig ? "需模型" : isSwitched ? ("→" + info.t) : info.t;
			const color = isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : "#06b6d4");
			const border = isErr || isNeedConfig ? "rgba(239,68,68,.5)" : (isOk ? "rgba(16,185,129,.5)" : "rgba(6,182,212,.45)");
			const bg = isErr || isNeedConfig ? "rgba(239,68,68,.08)" : (isOk ? "rgba(16,185,129,.08)" : "transparent");
			return react_jsx_runtime.jsx("button", {
				type: "button",
				title: "翻译：点击 = 把当前草稿翻译为 " + info.t + "\nShift + 点击 = 循环切换目标语言（EN→ZH→JA→KO）",
				onClick,
				disabled: busy || !draft,
				style: { display: "inline-flex", alignItems: "center", gap: "4px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid " + border, background: bg, color: isErr || isNeedConfig ? "#ef4444" : (isOk ? "#10b981" : "inherit"), cursor: busy || !draft ? "default" : "pointer", fontSize: "12px", fontWeight: 500, opacity: busy || !draft ? 0.5 : 1, whiteSpace: "nowrap", transition: "all .15s ease" },
				children: [
					react_jsx_runtime.jsx("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
						react_jsx_runtime.jsx("path", { d: "M5 8l6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6", key: "t" })
					] }),
					label
				]
			});
		}

		function registerTranslateButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-polish-translate",
				order: 36.5,
				inject: () => ({})
			}, TranslateButton));
		}

		function registerEnrichButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-polish-enrich",
				order: 36,
				inject: () => ({})
			}, EnrichButton));
		}

		function registerPolishButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-polish-btn",
				order: 35,
				inject: () => ({})
			}, PolishButton));
		}
		function registerMicButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-scribe-mic",
				order: 30,
				locale: SETTINGS_NS,
				inject: (sessionId) => ({
					t: ctx.locale.bind(SETTINGS_NS)
				})
			}, MicrophoneButton));
		}

		/**
		 * Register the settings section + row. Called from apply once the
		 * slots / locale services are available.
		 */
		function registerSettings(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SETTINGS_SECTION_ID,
				order: 30,
				// A thunk (not a fixed string) so the settings nav label follows the
				// UI locale: the shell resolves it through resolveSlotLabel on every
				// read, and re-reads it on each locale-revision bump.
				label: () => ctx.locale.bind(SETTINGS_NS)("section.title"),
				locale: SETTINGS_NS,
				children: { "settings.voiceScribe.item": {
					kind: "list",
					scope: "root"
				} }
			}, VoiceScribeSection));

			ctx.slots.inject("settings.voiceScribe.item", () => ctx.slots.register({
				name: "settings.voiceScribe.item",
				id: SETTINGS_SECTION_ID,
				order: 10,
				locale: SETTINGS_NS
			}, VoiceScribeRow));
		}
		//#endregion

		//#region plugin contract
		/** Required services: slots/locale for the settings section, plus the DOM. */
		const inject = ["slots", "locale"];

		/**
		 * Client loader entry: mount the hotkey while the plugin is active,
		 * register the settings section, and tear everything down on dispose.
		 */
		function apply(ctx) {
			// Composer buttons（右侧工具栏，5 个）
			const mounts = [
				["intensity", registerIntensityButton],
				["polish", registerPolishButton],
				["translate", registerTranslateButton],
				["enrich", registerEnrichButton],
				["history", registerHistoryButton]
			];
			for (const [name, reg] of mounts) {
				try {
					ctx.effect(() => { reg(ctx); return () => {}; }, "dsh-voice-polish: " + name);
				} catch (error) {
					console.warn("[voice-polish] " + name + " skipped:", error && error.message ? error.message : error);
				}
			}
			// Settings 面板（locale + section + lab 行）
			try {
				ctx.effect(() => ctx.locale.register(SETTINGS_NS, settingsLocale), "dsh-voice-polish: locale");
				ctx.effect(() => { registerSettings(ctx); return () => {}; }, "dsh-voice-polish: settings");
				ctx.effect(() => { registerPolishLab(ctx); return () => {}; }, "dsh-voice-polish: lab");
			} catch (error) {
				console.warn("[voice-polish] settings skipped:", error && error.message ? error.message : error);
			}
		}
		//#endregion

		module.exports = {
			apply,
			inject,
			boot,
			toggleRecording,
			readHotkey,
			readMode,
			readLanguage,
			readPolishEnabled,
			readPolishModel,
			readEngine,
			webSpeechSupported,
			HOTKEYS,
			CUSTOM_HOTKEY_PREFIX,
			parseHotkeyCombo,
			parseHotkey,
			canonicalComboText,
			serializeEventKey,
			hotkeyDisplay,
			matchesHotkey,
			matchesHoldRelease,
			DEFAULT_ASR_URL,
			DEFAULT_ASR_MODEL,
			readDeviceId,
			writeDeviceId,
			// Capture-device helpers are pure (storage / string math only) and are
			// exported for the offline tests.
			audioConstraints,
			shortDeviceLabel,
			silenceHint,
			// Composer-editor helpers are exported for the offline behavioural
			// tests (they are pure DOM adapters with no plugin state).
			findComposerEditor,
			readEditorText,
			writeEditorText,
			insertIntoComposer,
			isComposerEditable,
			appendSpeechSegment,
			draftText,
			setDraftText,
			setDraftChannel,
			writePreviewSpan,
			resetPreviewState,
			commitTranscript,
			rollbackPreview
		};
		return module.exports;
	}
});
