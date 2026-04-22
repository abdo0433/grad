// pythonService.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const PYTHON_URL = process.env.PYTHON_URL || 'http://localhost:8000';

// ============================================================
// HELPER: detect real audionMIME type from file magic bytes
// ============================================================
// Flutter Web's AudioRecorder always produces WebM/Opus from the browser's
// MediaRecorder API, even when AudioEncoder.wav is requested. The file arrives
// named "answer_TIMESTAMP.wav" but the bytes start with the WebM EBML header.
// Sending it to Python as "audio/wav" causes Whisper to fail silently because
// it tries to parse WebM bytes as PCM WAV and gets silence.
// This function reads the first 16 bytes and returns the real MIME type and
// the correct file extension so Python can save it with the right suffix.
function detectAudioFormat(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);

    // WebM / MKV — EBML magic bytes
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return { mimeType: 'audio/webm', ext: '.webm' };
    }
    // Ogg (Opus or Vorbis)
    if (buf.slice(0, 4).toString('ascii') === 'OggS') {
      return { mimeType: 'audio/ogg', ext: '.ogg' };
    }
    // RIFF WAV
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WAVE') {
      return { mimeType: 'audio/wav', ext: '.wav' };
    }
    // MP3 — ID3 tag or sync bytes
    if (buf.slice(0, 3).toString('ascii') === 'ID3' ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
      return { mimeType: 'audio/mpeg', ext: '.mp3' };
    }
    // MP4 / M4A
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
      return { mimeType: 'audio/mp4', ext: '.mp4' };
    }
    // Unknown — default to webm since that's what Flutter Web sends
    console.warn('⚠️  Unknown audio format, defaulting to webm');
    return { mimeType: 'audio/webm', ext: '.webm' };
  } catch (err) {
    console.warn('⚠️  detectAudioFormat failed:', err.message);
    return { mimeType: 'audio/webm', ext: '.webm' };
  }
}

// ============================================================
// START SESSION
// ============================================================
async function startPythonSession(jobTitle, jobDescription, cvFileBuffer, cvFileName) {
  try {
    const formData = new FormData();
    formData.append('job_title', jobTitle);
    formData.append('job_description', jobDescription);

    if (cvFileBuffer && cvFileName) {
      formData.append('cv_file', cvFileBuffer, {
        filename: cvFileName,
        contentType: 'application/pdf',
      });
    }

    const response = await axios.post(
      `${PYTHON_URL}/api/session/start`,
      formData,
      { headers: formData.getHeaders(), timeout: 60000 }
    );

    return response.data;
  } catch (err) {
    console.error(`⚠️ Python start session failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// GET NEXT QUESTION
// ============================================================
async function getNextQuestion(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/next-question`,
      { timeout: 60000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python next-question failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// AUDIO ANALYSIS + STT  ← key fix here
// ============================================================
async function analyzeAudio(pythonSessionId, file) {
  try {
    // Detect the REAL format from magic bytes — do NOT trust file.mimetype
    // or file.originalname because Flutter Web always sends WebM named as .wav
    const { mimeType, ext } = detectAudioFormat(file.path);

    // Build a corrected filename with the real extension so Python's endpoint
    // saves the temp file with the right suffix and Whisper can identify the format
    const correctedFilename = `audio_${Date.now()}${ext}`;

    console.log(`[analyzeAudio] detected format: ${mimeType} (${ext}), size: ${(file.size / 1024).toFixed(1)}KB`);

    const formData = new FormData();
    formData.append('file', fs.createReadStream(file.path), {
      filename: correctedFilename,   // ← correct extension, not the fake .wav name
      contentType: mimeType,            // ← real MIME type, not hardcoded 'audio/wav'
    });

    const response = await axios.post(
      `${PYTHON_URL}/api/session/${pythonSessionId}/audio-analysis`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    return response.data;
  } catch (err) {
    console.error(`⚠️ Python audio analysis failed: ${err.message}`);
    if (err.response) {
      console.error(`   Status: ${err.response.status}`, err.response.data);
    }
    return null;
  }
}

// ============================================================
// SUBMIT ANSWER TO PYTHON
// ============================================================
async function submitAnswerToPython(pythonSessionId, answerText, audioFeatures = null, videoFeatures = null) {
  try {
    const response = await axios.post(
      `${PYTHON_URL}/api/session/${pythonSessionId}/answer`,
      {
        session_id: pythonSessionId,
        answer: answerText,
        audio_features: audioFeatures,
        video_features: videoFeatures,
      },
      { timeout: 60000 }
    );

    return response.data;
  } catch (err) {
    console.error(`⚠️ Python submit answer failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// SEND CAMERA FRAME
// ============================================================
async function sendFrame(pythonSessionId, frameBase64) {
  try {
    if (!frameBase64 || typeof frameBase64 !== 'string' || frameBase64.length < 100) {
      console.warn('⚠️ Invalid frame_base64 (too short or not string)');
      return { success: false, buffered_frames: 0 };
    }

    const response = await axios.post(
      `${PYTHON_URL}/api/session/${pythonSessionId}/video-frame`,
      {
        session_id: pythonSessionId,
        frame_base64: frameBase64,
      },
      {
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    return response.data;
  } catch (err) {
    if (err.response) {
      console.error(`❌ Python video-frame failed: ${err.response.status}`, err.response.data);
    } else {
      console.error(`❌ Python video-frame error: ${err.message}`);
    }
    return { success: false, buffered_frames: 0 };
  }
}

// ============================================================
// GET VIDEO ANALYSIS
// ============================================================
async function getVideoAnalysis(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/video-analysis`,
      { timeout: 15000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python video analysis failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// GET FINAL FEEDBACK
// ============================================================
async function getFeedbackFromPython(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/feedback`,
      { timeout: 60000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python feedback failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// ANALYSIS: COMMUNICATION  (→ Comskills Flutter page)
// Returns: { overall_score, metrics, per_stage, raw_averages }
// ============================================================
async function getCommunicationAnalysis(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/analysis/communication`,
      { timeout: 60000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python communication analysis failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// ANALYSIS: BODY LANGUAGE  (→ Bodylang Flutter page)
// Returns: { overall_score, metrics, per_stage, emotion_breakdown, gaze_data }
// ============================================================
async function getBodyLanguageAnalysis(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/analysis/body-language`,
      { timeout: 60000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python body language analysis failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// ANALYSIS: TECHNICAL  (→ TechSkills Flutter page)
// Returns: { overall_score, scores, per_stage, per_question, strengths, weaknesses }
// ============================================================
async function getTechnicalAnalysis(pythonSessionId) {
  try {
    const response = await axios.get(
      `${PYTHON_URL}/api/session/${pythonSessionId}/analysis/technical`,
      { timeout: 60000 }
    );
    return response.data;
  } catch (err) {
    console.error(`⚠️ Python technical analysis failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
async function isPythonAlive() {
  try {
    const response = await axios.get(`${PYTHON_URL}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

module.exports = {
  startPythonSession,
  getNextQuestion,
  analyzeAudio,
  submitAnswerToPython,
  sendFrame,
  getVideoAnalysis,
  getFeedbackFromPython,
  getCommunicationAnalysis,
  getBodyLanguageAnalysis,
  getTechnicalAnalysis,
  isPythonAlive,
};