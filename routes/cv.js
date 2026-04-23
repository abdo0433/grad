const express = require("express");
const router = express.Router();
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const upload = multer({ dest: "uploads/" });

const FASTAPI_URL = process.env.FASTAPI_URL;

const authMiddleware = (req, res, next) => {
  const authHeader = req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      code: "401",
      message: "No token provided",
      data: null
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      code: "401",
      message: "Invalid or expired token",
      data: null
    });
  }
};

router.post("/upload-cv", authMiddleware, upload.single("cv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No CV file uploaded",
      });
    }

    const jdText = req.body.jd_text;

    if (!jdText || jdText.trim() === "") {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: "Job description is required",
      });
    }

    const formData = new FormData();
    formData.append("cv_file", fs.createReadStream(req.file.path), {
      filename: req.file.originalname || "cv.pdf",
      contentType: "application/pdf",
    });
    formData.append("jd_text", jdText);

    const response = await axios.post(`${FASTAPI_URL}/ats/match`, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });

    fs.unlinkSync(req.file.path);

    await User.findByIdAndUpdate(req.user.id, {
      atsScore: response.data.ats_score
    });

    res.json({
      success: true,
      ats_score: response.data.ats_score,
      matched_keywords: response.data.matched_keywords,
      missing_keywords: response.data.missing_keywords,
      analysis: response.data.analysis,
    });

  } catch (err) {
    console.error(err.message);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      message: "Error processing CV",
    });
  }
});

module.exports = router;
