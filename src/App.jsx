import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  Bell,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  Command,
  Cpu,
  Download,
  HardDrive,
  Mic,
  MicOff,
  MessageSquare,
  Play,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from "lucide-react";
import { encodeMonoWav } from "./audio.js";

const STORAGE_KEY = "jervis-conversation-v1";
const SETTINGS_KEY = "jervis-settings-v1";
const STARTER_MESSAGE = {
  id: "welcome",
  role: "assistant",
  content: "Systems ready. What are we working on?",
};

const SUGGESTIONS = [
  "Plan my day",
  "Help me think through a decision",
  "Draft a clear message",
];

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function formatTime(date) {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(date);
}

function transcriptSimilarity(left, right) {
  const a = new Set(String(left).toLowerCase().match(/[a-z0-9]+/g) || []);
  const b = new Set(String(right).toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

function isCancelPhrase(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:stop|cancel|quiet|forget it|scratch that|never ?mind|never mine|never mined|no remind(?:er)?|no never mind)$/.test(normalized);
}

function MessageText({ text }) {
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const body = part.slice(3, -3).replace(/^\w+\n/, "");
      return <pre key={index}><code>{body}</code></pre>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part.split("\n").map((line, lineIndex) => (
      <span key={`${index}-${lineIndex}`}>
        {line}
        {lineIndex < part.split("\n").length - 1 && <br />}
      </span>
    ));
  });
}

export function CoreVisual({ state, onClick, level = 0 }) {
  const active = ["armed", "awake", "listening", "transcribing", "speaking"].includes(state);
  return (
    <button className={`core-visual ${state} ${active ? "audio-active" : ""}`} style={{ "--voice-level": Math.max(0, Math.min(1, level)) }} onClick={onClick} aria-label="Toggle voice input">
      <span className="core-grid" />
      <span className="orbit orbit-one" />
      <span className="orbit orbit-two" />
      <span className="level-ring" />
      <span className="core-center">
        <span className="voice-wave" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</span>
        <span className="core-icon">{state === "speaking" ? <Volume2 size={28} /> : active ? <AudioLines size={30} /> : <Command size={31} />}</span>
      </span>
      <span className="pulse pulse-one" />
      <span className="pulse pulse-two" />
    </button>
  );
}

export default function App() {
  const [messages, setMessages] = useState(() => loadJson(STORAGE_KEY, [STARTER_MESSAGE]));
  const [settings, setSettings] = useState(() => ({
    model: "groq:openai/gpt-oss-20b",
    speak: true,
    handsFree: true,
    microphoneId: "default",
    voiceId: "933563129e564b19a115bedd57b7406a",
    ...loadJson(SETTINGS_KEY, {}),
  }));
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle");
  const [configured, setConfigured] = useState(false);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [cloudProviders, setCloudProviders] = useState([]);
  const [ollamaOnline, setOllamaOnline] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [microphones, setMicrophones] = useState([]);
  const [voiceOptions, setVoiceOptions] = useState([]);
  const [voicePreviewing, setVoicePreviewing] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [microphoneTest, setMicrophoneTest] = useState({ state: "idle", level: 0, message: "" });
  const [dashboard, setDashboard] = useState({ system: {}, events: [], reminders: [] });
  const [listeningMode, setListeningMode] = useState("off");
  const [now, setNow] = useState(new Date());
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const recorderStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const pcmProcessorRef = useRef(null);
  const pcmSilentGainRef = useRef(null);
  const pcmPreRollRef = useRef([]);
  const pcmPreRollSamplesRef = useRef(0);
  const pcmSegmentRef = useRef([]);
  const pcmSegmentSamplesRef = useRef(0);
  const pcmSampleRateRef = useRef(48000);
  const vadFrameRef = useRef(0);
  const speechStartedRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const voiceNoiseFloorRef = useRef(0.002);
  const discardRecordingRef = useRef(false);
  const voiceStartPendingRef = useRef(false);
  const listeningModeRef = useRef("off");
  const statusRef = useRef("idle");
  const speechActiveRef = useRef(false);
  const speechAudioRef = useRef(null);
  const speechUrlRef = useRef("");
  const speechVisualizationRef = useRef(null);
  const lastLevelUpdateRef = useRef(0);
  const orbVisibleRef = useRef(false);
  const orbHideTimerRef = useRef(0);
  const lastSpeechEndRef = useRef(0);
  const lastSpokenTextRef = useRef("");
  const wakeActiveUntilRef = useRef(0);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const textareaRef = useRef(null);
  const dictationRecorderRef = useRef(null);
  const dictationChunksRef = useRef([]);
  const dictationStreamRef = useRef(null);
  const dictationOwnsStreamRef = useRef(false);
  const discardDictationRef = useRef(false);
  const settingsRef = useRef(settings);

  const canListen = useMemo(
    () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
    [],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  function updateOrb(visible, state = statusRef.current, level = voiceLevel) {
    orbVisibleRef.current = visible;
    window.jervisDesktop?.updateOrb({ visible, state, level });
  }

  function revealOrb(state = "awake") {
    window.clearTimeout(orbHideTimerRef.current);
    updateOrb(true, state, Math.max(voiceLevel, 0.2));
  }

  function hideOrbSoon(delay = 1800) {
    window.clearTimeout(orbHideTimerRef.current);
    orbHideTimerRef.current = window.setTimeout(() => updateOrb(false, "armed", 0), delay);
  }

  useEffect(() => {
    if (!orbVisibleRef.current) return;
    const orbState = isSpeaking ? "speaking" : Date.now() < wakeActiveUntilRef.current && status === "armed" ? "awake" : status;
    window.jervisDesktop?.updateOrb({ visible: true, state: orbState, level: voiceLevel });
  }, [status, isSpeaking, voiceLevel]);

  useEffect(() => {
    if (!canListen) return undefined;
    const refresh = () => refreshMicrophones();
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
  }, [canListen]);

  useEffect(() => {
    if (settingsOpen) {
      refreshMicrophones();
      refreshVoices();
    }
  }, [settingsOpen]);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    fetch("/api/status")
      .then((response) => response.json())
      .then((data) => {
        setConfigured(Boolean(data.configured));
        setVoiceConfigured(Boolean(data.fishAudioConfigured));
        setCloudProviders([data.groqConfigured && "Groq", data.geminiConfigured && "Gemini", data.openAiConfigured && "OpenAI"].filter(Boolean));
        setOllamaOnline(Boolean(data.ollamaOnline));
        setSettings((current) => current.model.startsWith("ollama:") && data.configured
          ? { ...current, model: data.recommendedModel }
          : current);
      })
      .catch(() => setError("JERVIS core is offline."));
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const refreshDashboard = () => fetch("/api/dashboard")
      .then((response) => response.json())
      .then(setDashboard)
      .catch(() => null);
    refreshDashboard();
    const timer = setInterval(refreshDashboard, 15000);
    return () => clearInterval(timer);
  }, [messages]);

  function audioConstraints(deviceId = settingsRef.current.microphoneId) {
    return {
      ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  }

  async function refreshMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
      setMicrophones(devices);
      const selected = settingsRef.current.microphoneId;
      if (selected !== "default" && !devices.some((device) => device.deviceId === selected)) {
        setSettings((current) => ({ ...current, microphoneId: "default" }));
        setMicrophoneTest({ state: "missing", level: 0, message: "The selected microphone disconnected. Using the system default." });
        if (recorderStreamRef.current) {
          const mode = listeningModeRef.current;
          stopListening();
          setTimeout(() => startListening("default", mode === "manual" ? "manual" : "wake"), 150);
        }
      }
    } catch (deviceError) {
      setMicrophoneTest({ state: "error", level: 0, message: `Microphones could not be listed: ${deviceError.message}` });
    }
  }

  async function selectMicrophone(deviceId) {
    setSettings((current) => ({ ...current, microphoneId: deviceId }));
    settingsRef.current = { ...settingsRef.current, microphoneId: deviceId };
    setMicrophoneTest({ state: "idle", level: 0, message: "" });
    if (recorderStreamRef.current) {
      const mode = listeningModeRef.current;
      stopListening();
      setTimeout(() => startListening(deviceId, mode === "manual" ? "manual" : "wake"), 150);
    }
  }

  async function testMicrophone() {
    if (!canListen || microphoneTest.state === "testing") return;
    setMicrophoneTest({ state: "testing", level: 0, message: "Listening for a signal..." });
    let stream;
    let ownsStream = false;
    let context;
    try {
      const activeTrack = recorderStreamRef.current?.getAudioTracks()[0];
      const selectedId = settingsRef.current.microphoneId;
      const activeMatches = activeTrack && (selectedId === "default" || activeTrack.getSettings().deviceId === selectedId);
      stream = activeMatches ? recorderStreamRef.current : await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(selectedId) });
      ownsStream = !activeMatches;
      await refreshMicrophones();
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const deadline = performance.now() + 2200;
      let peak = 0;
      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const level = Math.min(1, Math.sqrt(energy / samples.length) * 12);
        peak = Math.max(peak, level);
        setMicrophoneTest({ state: "testing", level, message: "Listening for a signal..." });
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      setMicrophoneTest(peak > 0.025
        ? { state: "ready", level: peak, message: "Microphone signal detected." }
        : { state: "silent", level: peak, message: "No signal detected. Speak while testing or choose another microphone." });
    } catch (microphoneError) {
      const message = microphoneError.name === "NotAllowedError"
        ? "Microphone access is blocked in Windows or application permissions."
        : microphoneError.name === "NotFoundError" || microphoneError.name === "OverconstrainedError"
          ? "The selected microphone is unavailable."
          : `Microphone test failed: ${microphoneError.message}`;
      setMicrophoneTest({ state: "error", level: 0, message });
    } finally {
      await context?.close().catch(() => null);
      if (ownsStream) stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function refreshVoices() {
    try {
      const response = await fetch("/api/voices");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Voices could not be loaded.");
      setVoiceOptions(data.voices || []);
      if (!settingsRef.current.voiceId && data.defaultVoiceId) {
        setSettings((current) => ({ ...current, voiceId: data.defaultVoiceId }));
      }
    } catch (voiceError) {
      setError(voiceError.message);
    }
  }

  useEffect(() => {
    if (!settings.handsFree || !canListen) return undefined;
    const timer = setTimeout(() => startListening(undefined, "wake"), 1200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => stopListening(), []);

  useEffect(() => {
    if (!window.jervisDesktop) return undefined;
    const removeToggle = window.jervisDesktop.onDictationToggle(() => toggleDictation());
    const removeCancel = window.jervisDesktop.onDictationCancel(() => stopDictation(true));
    return () => {
      removeToggle?.();
      removeCancel?.();
      stopDictation(true);
    };
  }, []);

  function stopSpeechVisualization() {
    const visual = speechVisualizationRef.current;
    if (visual?.frame) cancelAnimationFrame(visual.frame);
    if (visual?.timer) clearInterval(visual.timer);
    visual?.context?.close().catch(() => null);
    speechVisualizationRef.current = null;
    setVoiceLevel(0);
    setIsSpeaking(false);
  }

  function visualizeSpeechAudio(audio) {
    stopSpeechVisualization();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.68;
    context.createMediaElementSource(audio).connect(analyser);
    analyser.connect(context.destination);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const visual = { context, analyser, frame: 0 };
    speechVisualizationRef.current = visual;
    const update = () => {
      analyser.getByteFrequencyData(frequencies);
      let energy = 0;
      for (let index = 2; index < Math.min(70, frequencies.length); index += 1) energy += frequencies[index];
      setVoiceLevel(Math.min(1, energy / (68 * 105)));
      visual.frame = requestAnimationFrame(update);
    };
    setIsSpeaking(true);
    context.resume().catch(() => null);
    update();
  }

  function speakWithBrowser(text, force = false) {
    if ((!settings.speak && !force) || !window.speechSynthesis || !text.trim()) return;
    stopSpeechVisualization();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, "code block"));
    speechActiveRef.current = true;
    setIsSpeaking(true);
    const timer = setInterval(() => setVoiceLevel(0.24 + Math.random() * 0.56), 90);
    speechVisualizationRef.current = { timer };
    utterance.rate = 1.02;
    utterance.pitch = 0.92;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /Daniel|Google UK English Male|Microsoft Ryan/i.test(voice.name)) || voices[0];
    utterance.onend = () => {
      speechActiveRef.current = false;
      lastSpeechEndRef.current = Date.now();
      stopSpeechVisualization();
      hideOrbSoon();
    };
    utterance.onerror = () => { speechActiveRef.current = false; stopSpeechVisualization(); hideOrbSoon(); };
    window.speechSynthesis.speak(utterance);
  }

  async function speak(text, voiceId = settings.voiceId, force = false) {
    if ((!settings.speak && !force) || !text.trim()) return;
    lastSpokenTextRef.current = text;
    speechAudioRef.current?.pause();
    if (speechUrlRef.current) URL.revokeObjectURL(speechUrlRef.current);
    window.speechSynthesis?.cancel();
    speechActiveRef.current = true;

    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId }),
      });
      if (!response.ok) throw new Error("Fish Audio voice unavailable");
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      speechUrlRef.current = audioUrl;
      speechAudioRef.current = audio;
      visualizeSpeechAudio(audio);
      audio.onended = () => {
        speechActiveRef.current = false;
        lastSpeechEndRef.current = Date.now();
        stopSpeechVisualization();
        URL.revokeObjectURL(audioUrl);
        if (speechUrlRef.current === audioUrl) speechUrlRef.current = "";
        hideOrbSoon();
      };
      audio.onerror = () => { speechActiveRef.current = false; stopSpeechVisualization(); hideOrbSoon(); };
      await audio.play();
    } catch {
      speechActiveRef.current = false;
      speakWithBrowser(text, force);
    }
  }

  async function previewVoice() {
    if (voicePreviewing) return;
    setVoicePreviewing(true);
    try { await speak("Voice selected. JERVIS is ready.", settings.voiceId, true); }
    finally { setTimeout(() => setVoicePreviewing(false), 1200); }
  }

  async function transcribeAudio(blob) {
    const mode = listeningModeRef.current;
    if (mode === "manual") setStatus("transcribing");
    try {
      const initialMode = mode === "manual" || Date.now() < wakeActiveUntilRef.current ? "command" : "wake";
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm", "X-Jervis-Transcription-Mode": initialMode },
        body: blob,
      });
      let data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Voice transcription failed.");
      let transcript = String(data.text || "").trim();
      if (!transcript) return;
      if (mode === "manual") {
        if (isCancelPhrase(transcript)) stopResponse();
        else await sendMessage(transcript);
        return;
      }
      const recentAssistantSpeech = speechActiveRef.current || Date.now() - lastSpeechEndRef.current < 8000;
      if (recentAssistantSpeech && transcriptSimilarity(transcript, lastSpokenTextRef.current) >= 0.72) return;
      const wakeUpOnlyPattern = /^wake\s+up[,\s]+(?:jarvis|jervis|jarves|jarviss|service|travis)[.!?,\s]*$/i;
      const nameOnlyPattern = /^(?:jarvis|jervis|jarves|jarviss|service|travis)[.!?,\s]*$/i;
      if (wakeUpOnlyPattern.test(transcript) || nameOnlyPattern.test(transcript)) {
        wakeActiveUntilRef.current = Date.now() + 12000;
        revealOrb("awake");
        setStatus("awake");
        if (wakeUpOnlyPattern.test(transcript)) await speak("Ready.");
        setTimeout(() => {
          if (Date.now() >= wakeActiveUntilRef.current && listeningModeRef.current === "wake" && statusRef.current !== "thinking") {
            setStatus("armed");
            hideOrbSoon();
          }
        }, 12100);
        return;
      }
      const leadingWakeCandidate = /^(?:wake\s+up[,\s]+)?(?:jarvis|jervis|jarves|jarviss|service|travis)\b/i;
      const localWakeCandidate = Boolean(data.local && leadingWakeCandidate.test(transcript));
      if (localWakeCandidate) {
        const cloudResponse = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": blob.type || "audio/webm", "X-Jervis-Transcription-Mode": "command" },
          body: blob,
        });
        const cloudData = await cloudResponse.json().catch(() => ({}));
        if (cloudResponse.ok && String(cloudData.text || "").trim()) {
          data = cloudData;
          transcript = String(cloudData.text).trim();
        }
      }
      if (localWakeCandidate && data.local) transcript = transcript.replace(leadingWakeCandidate, "Jarvis");
      const wakePattern = /\b(?:wake\s+up[,\s]+)?(?:jarvis|jervis)\b/gi;
      const wasWakeWorded = wakePattern.test(transcript);
      wakePattern.lastIndex = 0;
      const query = transcript.replace(wakePattern, " ").replace(/\s+/g, " ").trim().replace(/^[,.!?;:\s]+/, "");
      if ((wasWakeWorded || Date.now() < wakeActiveUntilRef.current) && isCancelPhrase(query)) {
        wakeActiveUntilRef.current = 0;
        stopResponse();
        await speak("Cancelled.");
        return;
      }
      const isAwakeFollowUp = Date.now() < wakeActiveUntilRef.current;
      if ((wasWakeWorded || isAwakeFollowUp) && query) {
        wakeActiveUntilRef.current = 0;
        revealOrb("thinking");
        await sendMessage(query);
      }
    } catch (transcriptionError) {
      setError(transcriptionError.message);
    } finally {
      if (mode === "manual") {
        stopListening();
        if (settingsRef.current.handsFree) setTimeout(() => startListening(undefined, "wake"), 250);
      } else {
        setStatus(recorderStreamRef.current ? "armed" : "idle");
      }
    }
  }

  function createSegmentRecorder() {
    if (recorderRef.current || statusRef.current === "transcribing" || statusRef.current === "thinking") return;
    pcmSegmentRef.current = pcmPreRollRef.current.slice();
    pcmSegmentSamplesRef.current = pcmPreRollSamplesRef.current;
    pcmPreRollRef.current = [];
    pcmPreRollSamplesRef.current = 0;
    speechStartedRef.current = performance.now();
    lastVoiceRef.current = performance.now();
    const recorder = {
      state: "recording",
      stop: () => {
        if (recorder.state !== "recording") return;
        recorder.state = "inactive";
        const chunks = pcmSegmentRef.current;
        const sampleCount = pcmSegmentSamplesRef.current;
        pcmSegmentRef.current = [];
        pcmSegmentSamplesRef.current = 0;
        recorderRef.current = null;
        const duration = sampleCount / pcmSampleRateRef.current;
        const shouldDiscard = discardRecordingRef.current;
        discardRecordingRef.current = false;
        if (!speechActiveRef.current) setVoiceLevel(0);
        if (!shouldDiscard && duration >= 0.25) {
          const wav = encodeMonoWav(chunks, pcmSampleRateRef.current);
          transcribeAudio(new Blob([wav], { type: "audio/wav" }));
        }
      },
    };
    recorderRef.current = recorder;
  }

  function monitorVoice() {
    const analyser = analyserRef.current;
    if (!analyser || !recorderStreamRef.current) return;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const rms = Math.sqrt(energy / samples.length);
    const nowMs = performance.now();
    const canCapture = !speechActiveRef.current && !dictationRecorderRef.current && !["thinking", "transcribing"].includes(statusRef.current);
    if (!recorderRef.current && rms < Math.max(voiceNoiseFloorRef.current * 3, 0.018)) {
      voiceNoiseFloorRef.current = voiceNoiseFloorRef.current * 0.96 + rms * 0.04;
    }
    const startThreshold = Math.max(0.0035, Math.min(0.014, voiceNoiseFloorRef.current * 1.75));
    const continueThreshold = Math.max(0.003, voiceNoiseFloorRef.current * 1.25);
    if (!speechActiveRef.current && nowMs - lastLevelUpdateRef.current > 55) {
      const audible = rms > voiceNoiseFloorRef.current * 1.15;
      setVoiceLevel(audible ? Math.min(1, rms / Math.max(0.025, startThreshold * 2.2)) : 0);
      lastLevelUpdateRef.current = nowMs;
    }

    if (canCapture && rms > (recorderRef.current ? continueThreshold : startThreshold)) {
      if (!recorderRef.current) createSegmentRecorder();
      lastVoiceRef.current = nowMs;
    }
    if (recorderRef.current && (
      nowMs - lastVoiceRef.current > 650 ||
      nowMs - speechStartedRef.current > 15000
    )) {
      discardRecordingRef.current = false;
      recorderRef.current.stop();
    }
    vadFrameRef.current = requestAnimationFrame(monitorVoice);
  }

  async function startListening(deviceId = settingsRef.current.microphoneId, mode = "manual") {
    setError("");
    if (recorderStreamRef.current || voiceStartPendingRef.current) return;
    if (!canListen) {
      setError("This system cannot record microphone audio.");
      return;
    }
    voiceStartPendingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(deviceId),
      });
      recorderStreamRef.current = stream;
      listeningModeRef.current = mode;
      setListeningMode(mode);
      voiceNoiseFloorRef.current = 0.002;
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (recorderStreamRef.current !== stream) return;
        setMicrophoneTest({ state: "missing", level: 0, message: "Microphone disconnected. Waiting for an available input." });
        stopListening();
        if (settingsRef.current.handsFree) setTimeout(() => startListening(undefined, "wake"), 1000);
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        if (recorderRef.current?.state === "recording") {
          pcmSegmentRef.current.push(chunk);
          pcmSegmentSamplesRef.current += chunk.length;
          return;
        }
        pcmPreRollRef.current.push(chunk);
        pcmPreRollSamplesRef.current += chunk.length;
        const limit = Math.round(audioContext.sampleRate * 0.4);
        while (pcmPreRollSamplesRef.current > limit && pcmPreRollRef.current.length > 1) {
          pcmPreRollSamplesRef.current -= pcmPreRollRef.current.shift().length;
        }
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      pcmProcessorRef.current = processor;
      pcmSilentGainRef.current = silentGain;
      pcmSampleRateRef.current = audioContext.sampleRate;
      setStatus(mode === "wake" ? "armed" : "listening");
      refreshMicrophones();
      monitorVoice();
    } catch (microphoneError) {
      setStatus("idle");
      listeningModeRef.current = "off";
      setListeningMode("off");
      if (microphoneError.name === "NotAllowedError") {
        setError("Microphone access is blocked. Allow JERVIS in Windows microphone privacy settings, then try again.");
      } else if (microphoneError.name === "NotFoundError" || microphoneError.name === "OverconstrainedError") {
        setError("No microphone was detected. Connect one or select an input device in system settings.");
      } else if (microphoneError.name === "NotReadableError") {
        setError("The microphone is already in use by another app. Close that app and try again.");
      } else {
        setError(`Microphone could not start: ${microphoneError.message}`);
      }
    } finally {
      voiceStartPendingRef.current = false;
    }
  }

  function stopListening() {
    cancelAnimationFrame(vadFrameRef.current);
    vadFrameRef.current = 0;
    if (recorderRef.current?.state === "recording") {
      discardRecordingRef.current = true;
      recorderRef.current.stop();
    }
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderStreamRef.current = null;
    analyserRef.current = null;
    if (pcmProcessorRef.current) pcmProcessorRef.current.onaudioprocess = null;
    pcmProcessorRef.current?.disconnect();
    pcmSilentGainRef.current?.disconnect();
    pcmProcessorRef.current = null;
    pcmSilentGainRef.current = null;
    pcmPreRollRef.current = [];
    pcmPreRollSamplesRef.current = 0;
    pcmSegmentRef.current = [];
    pcmSegmentSamplesRef.current = 0;
    audioContextRef.current?.close().catch(() => null);
    audioContextRef.current = null;
    if (!speechActiveRef.current) setVoiceLevel(0);
    listeningModeRef.current = "off";
    setListeningMode("off");
    setStatus("idle");
  }

  function toggleListening() {
    if (recorderStreamRef.current && listeningModeRef.current === "manual") {
      stopListening();
      if (settingsRef.current.handsFree) setTimeout(() => startListening(undefined, "wake"), 250);
    } else if (recorderStreamRef.current) {
      stopListening();
      setTimeout(() => startListening(undefined, "manual"), 150);
    } else {
      startListening(undefined, "manual");
    }
  }

  async function startDictation() {
    if (dictationRecorderRef.current || !canListen) return;
    if (recorderRef.current?.state === "recording") {
      discardRecordingRef.current = true;
      recorderRef.current.stop();
    }
    try {
      const sharedStream = recorderStreamRef.current;
      const stream = sharedStream || await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(),
      });
      dictationOwnsStreamRef.current = !sharedStream;
      dictationStreamRef.current = stream;
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
      dictationRecorderRef.current = recorder;
      dictationChunksRef.current = [];
      discardDictationRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) dictationChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        const discard = discardDictationRef.current;
        const blob = new Blob(dictationChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        dictationRecorderRef.current = null;
        dictationChunksRef.current = [];
        if (dictationOwnsStreamRef.current) stream.getTracks().forEach((track) => track.stop());
        dictationStreamRef.current = null;
        dictationOwnsStreamRef.current = false;
        window.jervisDesktop?.setDictationState(false);
        if (discard || blob.size < 1000) return;
        try {
          const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm", "X-Jervis-Transcription-Mode": "command" }, body: blob });
          const transcription = await response.json();
          if (!response.ok) throw new Error(transcription.error || "Dictation transcription failed.");
          const cleanedResponse = await fetch("/api/dictation/clean", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: transcription.text }) });
          const cleaned = await cleanedResponse.json();
          const text = String(cleaned.text || transcription.text || "").trim();
          if (!text) return;
          await fetch("/api/dictation/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
          window.jervisDesktop?.pasteText(text);
        } catch (dictationError) {
          setError(dictationError.message);
        }
      };
      recorder.start(250);
      window.jervisDesktop?.setDictationState(true);
    } catch (dictationError) {
      setError(`Dictation could not start: ${dictationError.message}`);
      window.jervisDesktop?.setDictationState(false);
    }
  }

  function stopDictation(discard = false) {
    const recorder = dictationRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    discardDictationRef.current = discard;
    recorder.stop();
  }

  function toggleDictation() {
    if (dictationRecorderRef.current?.state === "recording") stopDictation(false);
    else startDictation();
  }

  async function sendMessage(text = input) {
    const content = text.trim();
    if (!content || status === "thinking") return;

    setError("");
    window.speechSynthesis?.cancel();
    const userMessage = { id: crypto.randomUUID(), role: "user", content };
    const assistantId = crypto.randomUUID();
    const nextMessages = [...messages, userMessage].filter((message) => message.id !== "welcome");
    setMessages([...nextMessages, { id: assistantId, role: "assistant", content: "" }]);
    setInput("");
    setStatus("thinking");
    abortRef.current = new AbortController();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, model: settings.model }),
        signal: abortRef.current.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completeText = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw new Error(event.error);
          if (event.type === "delta") {
            completeText += event.text;
            const snapshot = completeText;
            setMessages((current) => current.map((message) =>
              message.id === assistantId ? { ...message, content: snapshot } : message,
            ));
          }
        }
        if (done) break;
      }
      speak(completeText);
    } catch (requestError) {
      if (requestError.name !== "AbortError") {
        setError(requestError.message);
        setMessages((current) => current.filter((message) => message.id !== assistantId));
      }
    } finally {
      setStatus(recorderStreamRef.current ? (listeningModeRef.current === "wake" ? "armed" : "listening") : "idle");
      abortRef.current = null;
      if (!settingsRef.current.speak) hideOrbSoon();
    }
  }

  function stopResponse() {
    abortRef.current?.abort();
    speechAudioRef.current?.pause();
    window.speechSynthesis?.cancel();
    setStatus(recorderStreamRef.current ? (listeningModeRef.current === "wake" ? "armed" : "listening") : "idle");
    hideOrbSoon(300);
  }

  function newConversation() {
    stopResponse();
    setMessages([STARTER_MESSAGE]);
    setError("");
    textareaRef.current?.focus();
  }

  async function clearMemory() {
    if (!window.confirm("Clear this conversation and JERVIS long-term memory?")) return;
    stopResponse();
    await fetch("/api/memory", { method: "DELETE" }).catch(() => null);
    setMessages([STARTER_MESSAGE]);
    localStorage.removeItem(STORAGE_KEY);
    setError("");
  }

  function exportConversation() {
    const transcript = messages
      .filter((message) => message.id !== "welcome")
      .map((message) => `${message.role === "assistant" ? "JERVIS" : "YOU"}\n${message.content}`)
      .join("\n\n");
    const url = URL.createObjectURL(new Blob([transcript], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `jervis-chat-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  const hasConversation = messages.some((message) => message.id !== "welcome");
  const activeMessages = messages.filter((message) => message.id !== "welcome");
  const providerName = settings.model.split(":")[0].toUpperCase();
  const visualStatus = isSpeaking ? "speaking" : status;
  const statusLabel = isSpeaking ? "JERVIS is speaking" : status === "awake" ? "Awake - waiting for command" : status === "armed" ? "Listening for wake word" : status === "listening" ? "Listening to your command" : status === "transcribing" ? "Understanding voice" : status === "thinking" ? "Processing request" : "Standing by";
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const formatSchedule = (value) => new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Command size={18} /></div>
          <strong>J.A.R.V.I.S</strong>
        </div>
        <span className="live-indicator"><i /> ACTIVE</span>
        <div className="date-display"><time>{formatTime(now)}</time><span>{new Intl.DateTimeFormat([], { month: "long", day: "numeric", year: "numeric" }).format(now)}</span></div>
        <div className="topbar-status">
          <span className={`status-chip ${ollamaOnline || configured ? "online" : "offline"}`}>
            <Wifi size={13} /> {configured ? "CLOUD CORE" : ollamaOnline ? "LOCAL CORE" : "CORE OFFLINE"}
          </span>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Open settings">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="dashboard-side system-panel">
          <section className="greeting-block">
            <span className="section-label">PERSONAL ASSISTANT</span>
            <h2>{greeting}, Jay</h2>
            <p>All primary systems are {ollamaOnline || configured ? "ready" : "waiting for a model"}.</p>
          </section>
          <section className="dashboard-section">
            <h3><Activity size={16} /> SYSTEM STATUS</h3>
            <div className="stat-row"><span>Memory</span><div className="stat-track"><i style={{ width: `${dashboard.system.memoryUsedPercent || 0}%` }} /></div><b>{dashboard.system.memoryUsedPercent || 0}%</b></div>
            <div className="stat-row"><span>Uptime</span><div className="stat-track"><i style={{ width: `${Math.min(100, (dashboard.system.uptimeHours || 0) / 2)}%` }} /></div><b>{dashboard.system.uptimeHours || 0}h</b></div>
            <div className="stat-row"><span>Tools</span><div className="stat-track"><i style={{ width: `${Math.min(100, (dashboard.system.tools || 0) * 2.5)}%` }} /></div><b>{dashboard.system.tools || 0}</b></div>
            <div className="network-line"><span className={`signal-dot ${ollamaOnline || configured ? "online" : ""}`} /> CORE {ollamaOnline || configured ? "ONLINE" : "OFFLINE"}</div>
          </section>
          <section className="dashboard-section config-block">
            <h3><Cpu size={16} /> AI CONFIGURATION</h3>
            <div className="config-row"><span>Engine</span><b>{providerName}</b></div>
            <div className="config-row"><span>Model</span><b title={settings.model}>{settings.model.split(":").at(-1)}</b></div>
            <div className="config-row"><span>Voice</span><b>{voiceConfigured && settings.speak ? "FISH AUDIO" : settings.speak ? "SYSTEM" : "OFF"}</b></div>
            <div className="config-row"><span>Microphone</span><b>{status === "listening" ? "MANUAL" : status === "armed" ? "WAKE ARMED" : "OFF"}</b></div>
          </section>
          <div className="side-actions">
            <button onClick={newConversation}><Plus size={16} /> New session</button>
            <button onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> Control center</button>
          </div>
        </aside>

        <section className="core-stage">
          <div className="core-readout"><span>NEURAL INTERFACE</span><b>{statusLabel.toUpperCase()}</b></div>
          <CoreVisual state={visualStatus} level={voiceLevel} onClick={toggleListening} />
          <div className="core-title">
            <h1>J.A.R.V.I.S</h1>
            <p>{statusLabel}</p>
            <div className="wake-commands"><span>JARVIS</span><span>WAKE UP JARVIS</span></div>
          </div>
          <div className="central-input">
            {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
            <div className={`composer ${status === "listening" ? "listening" : ""}`}>
              <button className="voice-button" onClick={toggleListening} title={status === "listening" ? "Stop manual input" : "Start manual voice input"} aria-label="Toggle voice input">{status === "listening" ? <MicOff size={20} /> : <Mic size={20} />}</button>
              <textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder={status === "awake" ? "Ready for your command..." : status === "armed" ? "Say JARVIS to begin..." : status === "listening" ? "Listening to your command..." : status === "transcribing" ? "Transcribing voice..." : "Type a command..."} rows={1} aria-label="Message JERVIS" />
              {status === "thinking" ? <button className="send-button stop" onClick={stopResponse} title="Stop response" aria-label="Stop response"><Square size={16} /></button> : <button className="send-button" onClick={() => sendMessage()} disabled={!input.trim()} title="Send message" aria-label="Send message"><Send size={17} /></button>}
            </div>
            <div className="suggestions">{SUGGESTIONS.map((suggestion) => <button key={suggestion} onClick={() => sendMessage(suggestion)}>{suggestion}</button>)}</div>
          </div>
        </section>

        <aside className="dashboard-side activity-panel">
          <section className="dashboard-section conversation-card">
            <div className="section-heading">
              <h3><MessageSquare size={16} /> CONVERSATION</h3>
              <div className="section-tools"><button onClick={clearMemory} disabled={!hasConversation} title="Clear conversation" aria-label="Clear conversation"><Trash2 size={15} /></button><button onClick={exportConversation} disabled={!hasConversation} title="Export conversation" aria-label="Export conversation"><Download size={15} /></button></div>
            </div>
            <div className="conversation-feed" aria-live="polite">
              {!hasConversation && <div className="empty-list"><Bot size={18} /><span>Ready for your first command.</span></div>}
              {activeMessages.map((message) => <article className={`feed-message ${message.role}`} key={message.id}><strong>{message.role === "assistant" ? "JERVIS" : "YOU"}</strong>{message.content ? <div><MessageText text={message.content} /></div> : <span className="thinking-dots"><i /><i /><i /></span>}</article>)}
              <div ref={endRef} />
            </div>
          </section>
          <section className="dashboard-section schedule-card">
            <div className="section-heading"><h3><CalendarDays size={16} /> UPCOMING EVENTS</h3><button onClick={() => sendMessage("Show my calendar")} title="Open calendar" aria-label="Open calendar"><Plus size={15} /></button></div>
            <div className="schedule-list">{dashboard.events.length ? dashboard.events.map((event) => <button key={event.id} onClick={() => sendMessage(`Tell me about the calendar event ${event.title}`)}><span>{event.title}</span><time>{formatSchedule(event.start)}</time></button>) : <p>No upcoming events</p>}</div>
          </section>
          <section className="dashboard-section schedule-card reminders-card">
            <div className="section-heading"><h3><Bell size={16} /> REMINDERS</h3><button onClick={() => sendMessage("List my reminders")} title="Open reminders" aria-label="Open reminders"><Plus size={15} /></button></div>
            <div className="schedule-list">{dashboard.reminders.length ? dashboard.reminders.map((reminder) => <button key={reminder.id} onClick={() => sendMessage("List my reminders")}><span>{reminder.text}</span><time>{formatSchedule(reminder.at)}</time></button>) : <p>No active reminders</p>}</div>
          </section>
        </aside>
      </main>

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog" aria-label="JERVIS settings">
            <header><div><span className="section-label">CONFIGURATION</span><h2>System settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button></header>
            <div className="setting-row">
              <div><strong>Voice responses</strong><span>Read completed answers aloud</span></div>
              <button className={`toggle ${settings.speak ? "active" : ""}`} onClick={() => setSettings((current) => ({ ...current, speak: !current.speak }))} role="switch" aria-checked={settings.speak}>
                <span>{settings.speak ? <Volume2 size={14} /> : <VolumeX size={14} />}</span>
              </button>
            </div>
            <div className="setting-stack voice-setting">
              <label htmlFor="voice-model">Fish Audio voice</label>
              <div className="microphone-control">
                <div className="select-wrap">
                  <select id="voice-model" value={settings.voiceId} onChange={(event) => setSettings((current) => ({ ...current, voiceId: event.target.value }))}>
                    {!voiceOptions.length && <option value="933563129e564b19a115bedd57b7406a">Sarah</option>}
                    {voiceOptions.map((voice) => <option key={voice.id} value={voice.id}>{voice.personal ? `My voice - ${voice.name}` : voice.name}</option>)}
                  </select>
                  <ChevronDown size={17} />
                </div>
                <button className="voice-preview-button" onClick={previewVoice} disabled={voicePreviewing || !voiceConfigured} title="Preview selected voice">
                  <Play size={14} /> <span>{voicePreviewing ? "Playing" : "Preview"}</span>
                </button>
              </div>
              <p className="microphone-message ready">The selected voice is saved and used for every response.</p>
            </div>
            <div className="setting-row">
              <div><strong>Hands-free listening</strong><span>Respond when you say Jarvis or Jervis</span></div>
              <button className={`toggle ${settings.handsFree ? "active" : ""}`} onClick={() => {
                const enabled = !settings.handsFree;
                setSettings((current) => ({ ...current, handsFree: enabled }));
                if (enabled) startListening(undefined, "wake"); else stopListening();
              }} role="switch" aria-checked={settings.handsFree}>
                <span>{settings.handsFree ? <Mic size={14} /> : <MicOff size={14} />}</span>
              </button>
            </div>
            <div className="setting-stack microphone-setting">
              <label htmlFor="microphone">Microphone input</label>
              <div className="microphone-control">
                <div className="select-wrap">
                  <select id="microphone" value={settings.microphoneId || "default"} onChange={(event) => selectMicrophone(event.target.value)}>
                    <option value="default">System default microphone</option>
                    {microphones.filter((device) => device.deviceId !== "default").map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
                    ))}
                  </select>
                  <ChevronDown size={17} />
                </div>
                <button className="microphone-test-button" onClick={testMicrophone} disabled={microphoneTest.state === "testing"} title="Test selected microphone">
                  <AudioLines size={15} /> <span>{microphoneTest.state === "testing" ? "Testing" : "Test"}</span>
                </button>
              </div>
              <div className={`microphone-meter ${microphoneTest.state}`} aria-label="Microphone signal level">
                <span style={{ width: `${Math.max(2, microphoneTest.level * 100)}%` }} />
              </div>
              <p className={`microphone-message ${microphoneTest.state}`}>{microphoneTest.message || (microphones.length ? `${microphones.length} input device${microphones.length === 1 ? "" : "s"} available.` : "Test to grant access and detect microphones.")}</p>
            </div>
            <div className="setting-stack">
              <label htmlFor="model">Intelligence model</label>
              <div className="select-wrap">
                <select id="model" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}>
                  <option value="ollama:gemma3:4b">Local Gemma 3 · Private</option>
                  <option value="groq:openai/gpt-oss-120b">Groq GPT-OSS 120B · Fast</option>
                  <option value="groq:openai/gpt-oss-20b">Groq GPT-OSS 20B · Efficient</option>
                  <option value="gemini:gemini-3.6-flash">Gemini 3.6 Flash · Balanced</option>
                  <option value="gemini:gemini-3.7-flash">Gemini 3.7 Flash · Frontier</option>
                  <option value="gpt-5.6-luna">GPT-5.6 Luna · Fast</option>
                  <option value="gpt-5.6-terra">GPT-5.6 Terra · Balanced</option>
                  <option value="gpt-5.6-sol">GPT-5.6 Sol · Frontier</option>
                </select>
                <ChevronDown size={17} />
              </div>
            </div>
            <div className={`key-status ${configured ? "ready" : "missing"}`}>
              {configured ? <Check size={16} /> : <X size={16} />}
              <div><strong>{configured ? `${cloudProviders.join(" + ")} configured` : "Cloud API key not found"}</strong><span>{configured ? "Private keys are loaded securely by the local core." : "Add a provider key, then refresh."}</span></div>
            </div>
            <div className={`key-status voice-key ${voiceConfigured ? "ready" : "missing"}`}>
              {voiceConfigured ? <Check size={16} /> : <X size={16} />}
              <div><strong>{voiceConfigured ? "Fish Audio voice configured" : "Fish Audio key not found"}</strong><span>{voiceConfigured ? "The selected voice model is pinned for consistent responses." : "Save your key in fish-api.txt, then refresh."}</span></div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
