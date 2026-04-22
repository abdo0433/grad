const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const User = require('../models/User');

// ✅ Temporary storage for unverified users
const pendingUsers = new Map();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});


router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Name, email and password are required',
        data: null
      });
    }

    // Check in database
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        code: "409",
        message: 'Email already exists',
        data: null
      });
    }

    // Reset pending if exists
    if (pendingUsers.has(email)) {
      pendingUsers.delete(email);
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // ✅ Save in memory only — NOT in database yet
    pendingUsers.set(email, {
      name,
      email,
      password: hashedPassword,
      verificationCode,
      createdAt: Date.now()
    });

    await transporter.sendMail({
      from: `"Talk2Hire" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Email Verification Code',
      text: `Your verification code is: ${verificationCode}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Email Verification</h2>
          <p>Your verification code is:</p>
          <h1 style="letter-spacing: 8px; color: #4F46E5;">${verificationCode}</h1>
          <p style="color: #666;">This code is valid for 10 minutes.</p>
        </div>
      `
    });

    return res.status(200).json({
      success: true,
      code: "200",
      message: 'Verification code sent to your email',
      data: null
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      code: "500",
      message: 'Server error',
      data: null
    });
  }
});


router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Email and code are required',
        data: null
      });
    }

    // ✅ Check in pending memory
    const pendingUser = pendingUsers.get(email);

    if (!pendingUser) {
      return res.status(404).json({
        success: false,
        code: "404",
        message: 'No pending registration found for this email',
        data: null
      });
    }

    // Check code expiry (10 minutes)
    const tenMinutes = 10 * 60 * 1000;
    if (Date.now() - pendingUser.createdAt > tenMinutes) {
      pendingUsers.delete(email);
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Verification code expired',
        data: null
      });
    }

    if (pendingUser.verificationCode !== code) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Invalid verification code',
        data: null
      });
    }

    // ✅ Save in database only after verification
    const user = new User({
      name: pendingUser.name,
      email: pendingUser.email,
      password: pendingUser.password,
      isVerified: true,
      verificationCode: null
    });

    await user.save();

    // Remove from pending
    pendingUsers.delete(email);

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      success: true,
      code: "200",
      message: 'Email verified successfully',
      data: {
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email
        }
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      code: "500",
      message: 'Server error',
      data: null
    });
  }
});


router.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Email is required',
        data: null
      });
    }

    const pendingUser = pendingUsers.get(email);

    if (!pendingUser) {
      return res.status(404).json({
        success: false,
        code: "404",
        message: 'No pending registration found for this email',
        data: null
      });
    }

    // Generate new code and reset timer
    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingUser.verificationCode = newCode;
    pendingUser.createdAt = Date.now();
    pendingUsers.set(email, pendingUser);

    await transporter.sendMail({
      from: `"Talk2Hire" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'New Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Email Verification</h2>
          <p>Your new verification code is:</p>
          <h1 style="letter-spacing: 8px; color: #4F46E5;">${newCode}</h1>
          <p style="color: #666;">This code is valid for 10 minutes.</p>
        </div>
      `
    });

    return res.status(200).json({
      success: true,
      code: "200",
      message: 'New verification code sent',
      data: null
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      code: "500",
      message: 'Server error',
      data: null
     });
  }
});


router.post('/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Email and password are required',
        data: null
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Invalid credentials',
        data: null
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        code: "403",
        message: 'Please verify your email first',
        data: null
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        code: "400",
        message: 'Invalid credentials',
        data: null
      });
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '1d' }
    );

    return res.status(200).json({
      success: true,
      code: "200",
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email
        }
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      code: "500",
      message: 'Server error',
      data: null
    });
  }
});


router.post('/logout', (req, res) => {
  return res.status(200).json({
    success: true,
    code: "200",
    message: 'Logout successful',
    data: null
  });
});

module.exports = router;