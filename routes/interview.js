// interview.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const { startPythonSession, getNextQuestion, sendFrame, getVideoAnalysis, isPythonAlive, analyzeAudio, submitAnswerToPython, getFeedbackFromPython, getCommunicationAnalysis, getBodyLanguageAnalysis, getTechnicalAnalysis } = require('../services/pythonService');
// interviewService no longer needed — all Python calls go through pythonService directly

// ============================================================
// Multer Setup
// ============================================================
const uploadCV = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files are allowed'), false);
  },
});

const uploadAudio = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // FIX 1: Flutter Web sends WebM/Opus even when the file is named .wav.
    // The browser sets mimetype to audio/webm, audio/ogg, or audio/wav.
    // Accept all of them — the Python STT engine handles the conversion.
    const allowed = [
      'audio/wav', 'audio/x-wav', 'audio/wave',
      'audio/webm', 'audio/ogg', 'audio/mpeg',
      'application/octet-stream', // some browsers send this as fallback
    ];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(null, true); // accept anything — let Python decide
  },
});

// ============================================================
// In-memory Sessions
// ============================================================
const sessions = new Map();

function cleanup(file) {
  if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
}

// ============================================================
// START INTERVIEW
// ============================================================
router.post('/session/start-with-cv', uploadCV.single('cv'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'CV PDF file is required' });
    }

    const { job_title, job_description } = req.body;

    if (!job_title?.trim() || !job_description?.trim()) {
      cleanup(req.file);
      return res.status(400).json({ success: false, message: 'job_title and job_description are required' });
    }

    const cvBuffer   = fs.readFileSync(req.file.path);
    const cvFileName = req.file.originalname || 'cv.pdf';
    cleanup(req.file);

    const startRes = await startPythonSession(job_title, job_description, cvBuffer, cvFileName);

    if (!startRes || !startRes.session_id) {
      return res.status(500).json({ success: false, message: 'AI service unavailable' });
    }

    const pythonSessionId = startRes.session_id;
    const questionRes = await getNextQuestion(pythonSessionId);

    if (!questionRes) {
      return res.status(500).json({ success: false, message: 'Failed to get first question' });
    }

    const nodeSessionId = uuidv4();

    sessions.set(nodeSessionId, {
      python_session_id:       pythonSessionId,
      status:                  'active',
      current_question:        questionRes.question,
      current_question_audio:  questionRes.question_audio || null,
      current_stage:           questionRes.stage,
      current_question_number: questionRes.question_number,
      current_total_questions: questionRes.total_questions,
      created_at:              new Date().toISOString(),
    });

    return res.status(201).json({
      success:              true,
      session_id:           nodeSessionId,
      first_question:       questionRes.question,
      first_question_audio: questionRes.question_audio || null,
      stage:                questionRes.stage,
      question_number:      questionRes.question_number,
      total_questions:      questionRes.total_questions,
      cv_parsed:            startRes.cv_parsed || false,
      message:              'Interview started successfully',
    });

  } catch (err) {
    console.error('Start session error:', err);
    cleanup(req.file);
    return res.status(500).json({ success: false, message: 'Error starting interview' });
  }
});

// ============================================================
// GET CURRENT QUESTION  (legacy alias — returns cached question from session)
// ============================================================
router.get('/session/:session_id/question', (req, res) => {
  try {
    const { session_id } = req.params;
    const session = sessions.get(session_id);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    return res.json({
      success:         true,
      question:        session.current_question,
      question_audio:  session.current_question_audio,
      stage:           session.current_stage,
      question_number: session.current_question_number,
      total_questions: session.current_total_questions,
    });

  } catch (err) {
    console.error('Get question error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// GET NEXT QUESTION  ← THIS ROUTE WAS MISSING — caused the 404
// ============================================================
// Flutter calls GET /session/:id/next-question to fetch the first question
// after session start, and after each answer submission.
// This route proxies to Python which generates the question + TTS audio,
// then caches the result in the Node session so /question still works too.
router.get('/session/:session_id/next-question', async (req, res) => {
  try {
    const { session_id } = req.params;
    const session = sessions.get(session_id);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    if (session.status === 'completed') {
      return res.status(409).json({ success: false, message: 'Interview already completed' });
    }

    const { python_session_id } = session;
    const questionRes = await getNextQuestion(python_session_id);

    if (!questionRes) {
      return res.status(502).json({ success: false, message: 'Failed to get next question from AI' });
    }

    // Cache in Node session so /question alias stays consistent
    session.current_question        = questionRes.question;
    session.current_question_audio  = questionRes.question_audio  || null;
    session.current_stage           = questionRes.stage;
    session.current_question_number = questionRes.question_number;
    session.current_total_questions = questionRes.total_questions;

    return res.json({
      success:         true,
      question:        questionRes.question,
      question_audio:  questionRes.question_audio  || null,
      stage:           questionRes.stage,
      stage_index:     questionRes.stage_index,
      question_number: questionRes.question_number,
      total_questions: questionRes.total_questions,
      is_first:        questionRes.is_first        || false,
      message:         questionRes.message         || '',
    });

  } catch (err) {
    console.error('Next question error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// FIX 2: SEND CAMERA FRAME — accept BOTH /frame AND /video-frame
// ============================================================
// The old route was POST /session/:id/frame
// Flutter now sends to POST /session/:id/video-frame (after repo fix)
// We register both paths pointing to the same handler so neither breaks.

async function handleFrame(req, res) {
  try {
    const { session_id } = req.params;
    const frame_base64   = req.body.frame_base64 || req.body.frame;

    if (!sessions.has(session_id)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    if (!frame_base64 || typeof frame_base64 !== 'string') {
      return res.status(400).json({ success: false, message: 'frame_base64 is required' });
    }

    const { python_session_id } = sessions.get(session_id);
    const result = await sendFrame(python_session_id, frame_base64);

    return res.json({
      success:         true,
      buffered_frames: result?.buffered_frames || 0,
    });

  } catch (err) {
    console.error('Frame endpoint error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send frame' });
  }
}

router.post('/session/:session_id/frame',       express.json({ limit: '5mb' }), handleFrame);
router.post('/session/:session_id/video-frame', express.json({ limit: '5mb' }), handleFrame);

// ============================================================
// FIX 3: AUDIO ANALYSIS — this route was completely missing
// ============================================================
// Flutter calls POST /session/:id/audio-analysis with the raw audio blob.
// This route forwards the file to Python for STT + feature extraction and
// returns { transcription, audio_features } back to Flutter (or interviewService).

router.post('/session/:session_id/audio-analysis', uploadAudio.single('file'), async (req, res) => {
  try {
    const { session_id } = req.params;

    if (!sessions.has(session_id)) {
      cleanup(req.file);
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Audio file is required' });
    }

    const { python_session_id } = sessions.get(session_id);

    const result = await analyzeAudio(python_session_id, req.file);
    cleanup(req.file);

    if (!result) {
      return res.status(502).json({ success: false, message: 'Audio analysis failed' });
    }

    return res.json(result);

  } catch (err) {
    console.error('Audio analysis error:', err);
    cleanup(req.file);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// SUBMIT ANSWER  — accepts JSON {answer, audio_features, video_features}
// ============================================================
// Flutter's interview_repository.dart calls /audio-analysis first (to get
// the transcription), then calls /answer with the transcription as JSON.
// This route must use express.json(), NOT multer — there is no file here.
router.post('/session/:session_id/answer', express.json(), async (req, res) => {
  try {
    const { session_id } = req.params;

    if (!sessions.has(session_id)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const session = sessions.get(session_id);

    if (session.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Interview already completed' });
    }

    // Body sent by Flutter: { session_id, answer, audio_features? }
    const answerText    = req.body.answer?.trim();
    const audioFeatures = req.body.audio_features || null;

    if (!answerText) {
      return res.status(400).json({ success: false, message: 'answer text is required' });
    }

    const { python_session_id } = session;

    // Get latest video features from Python buffer
    const videoResult   = await getVideoAnalysis(python_session_id);
    const videoFeatures = videoResult?.has_data ? videoResult.features : null;

    // Forward to Python /answer for evaluation + get next question inline
    const answerRes = await submitAnswerToPython(
      python_session_id,
      answerText,
      audioFeatures,
      videoFeatures,
    );

    if (!answerRes) {
      return res.status(502).json({ success: false, message: 'AI service unavailable' });
    }

    // next_question is returned inline by the updated Python backend
    let nextQuestion      = answerRes.next_question      || null;
    let nextQuestionAudio = answerRes.next_question_audio || null;

    // Fallback: if Python didn't include it inline, fetch separately
    if (!answerRes.interview_complete && !nextQuestion) {
      const questionRes = await getNextQuestion(python_session_id);
      if (questionRes?.question) {
        nextQuestion      = questionRes.question;
        nextQuestionAudio = questionRes.question_audio || null;
        // Update Node session cache
        session.current_question        = nextQuestion;
        session.current_question_audio  = nextQuestionAudio;
        session.current_stage           = questionRes.stage;
        session.current_question_number = questionRes.question_number;
        session.current_total_questions = questionRes.total_questions;
      }
    } else if (nextQuestion) {
      session.current_question       = nextQuestion;
      session.current_question_audio = nextQuestionAudio;
      session.current_stage          = answerRes.next_stage || session.current_stage;
    }

    if (answerRes.interview_complete) {
      session.status                 = 'completed';
      session.current_question       = null;
      session.current_question_audio = null;
    }

    return res.json({
      success:             true,
      next_question:       nextQuestion,
      next_question_audio: nextQuestionAudio,
      stage:               answerRes.next_stage        || session.current_stage,
      stage_complete:      answerRes.stage_complete    || false,
      interview_complete:  answerRes.interview_complete || false,
      evaluation_summary:  answerRes.evaluation_summary || {},
      message:             answerRes.message            || 'Answer recorded.',
    });

  } catch (err) {
    console.error('Submit answer error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// FEEDBACK, STATUS, DELETE, HEALTH
// ============================================================
router.get('/session/:session_id/feedback', async (req, res) => {
  try {
    const { session_id } = req.params;
    if (!sessions.has(session_id)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const { python_session_id } = sessions.get(session_id);

    // Call all three Python analysis endpoints in parallel for speed.
    // Each endpoint returns exactly the shape the matching Flutter page expects:
    //   getCommunicationAnalysis → Comskills  (metrics, per_stage, raw_averages)
    //   getBodyLanguageAnalysis  → Bodylang   (metrics, emotion_breakdown, gaze_data, per_stage)
    //   getTechnicalAnalysis     → TechSkills (scores, per_question, strengths, weaknesses)
    const [commData, bodyData, techData, feedbackData] = await Promise.all([
      getCommunicationAnalysis(python_session_id),
      getBodyLanguageAnalysis(python_session_id),
      getTechnicalAnalysis(python_session_id),
      getFeedbackFromPython(python_session_id),
    ]);

    if (!feedbackData) {
      return res.status(500).json({ success: false, message: 'Could not generate feedback' });
    }

    return res.json({
      success: true,
      status:  'ready',

      // Top-level summary
      overall_score:           feedbackData.overall_score           || 0,
      recommendation:          feedbackData.recommendation          || '',
      strengths:               feedbackData.strengths               || [],
      weaknesses:              feedbackData.weaknesses              || [],
      improvement_suggestions: feedbackData.improvement_suggestions || [],

      // Comskills page reads reportData['communication_skills']
      // It expects: { overall_score, metrics, per_stage, raw_averages }
      communication_skills: commData || {
        overall_score: feedbackData.communication_score || 0,
        metrics: {}, per_stage: {}, raw_averages: {},
      },

      // Bodylang page reads reportData['body_language']
      // It expects: { overall_score, metrics, emotion_breakdown, gaze_data, per_stage }
      body_language: bodyData || {
        overall_score: feedbackData.professional_presence || 0,
        metrics: {}, emotion_breakdown: {}, gaze_data: {}, per_stage: {},
      },

      // TechSkills page reads reportData['technical_skills']
      // It expects: { overall_score, scores, per_question, strengths, weaknesses }
      technical_skills: techData || {
        overall_score: feedbackData.technical_score || 0,
        scores: {
          technical:     feedbackData.technical_score     || 0,
          relevance:     feedbackData.technical_score     || 0,
          communication: feedbackData.communication_score || 0,
        },
        per_question: [],
        strengths:    feedbackData.strengths  || [],
        weaknesses:   feedbackData.weaknesses || [],
      },
    });

  } catch (err) {
    console.error('Feedback error:', err);
    return res.status(500).json({ success: false, message: 'Error generating feedback' });
  }
});

router.get('/session/:session_id/status', (req, res) => {
  const { session_id } = req.params;
  const session = sessions.get(session_id);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }
  return res.json({ success: true, session_id, status: session.status });
});

router.delete('/session/:session_id', (req, res) => {
  const { session_id } = req.params;
  if (sessions.has(session_id)) {
    sessions.delete(session_id);
  }
  return res.json({ success: true, message: 'Session ended' });
});

router.get('/python-status', async (req, res) => {
  const alive = await isPythonAlive();
  return res.json({ success: true, python_ai_online: alive });
});

module.exports = router;