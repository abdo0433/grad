  const express = require('express');
  const router = express.Router();
  const User = require('../models/User');
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');



  const authMiddleware = (req, res, next) => {
    const authHeader = req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        code: "401",
        message: 'No token provided',
        data: null
      });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({
        success: false,
        code: "401",
        message: 'Invalid or expired token',
        data: null
      });
    }
  };



  router.get('/profile', authMiddleware, async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select('-password');

      if (!user) {
        return res.status(404).json({
          success: false,
          code: "404",
          message: 'User not found',
          data: null
        });
      }

      return res.status(200).json({
        success: true,
        code: "200",
        message: 'Profile fetched successfully',
        data: user
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



  router.post('/update-profile', authMiddleware, async (req, res) => {
    try {

      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({
          success: false,
          code: "404",
          message: 'User not found',
          data: null
        });
      }

      const { name, email, password, oldPassword } = req.body;

      
      if (email && email !== user.email) {
        const emailExists = await User.findOne({ email });
        if (emailExists) {
          return res.status(400).json({
            success: false,
            code: "400",
            message: "Email already in use",
            data: null
          });
        }
        user.email = email;
      }

    
      if (name) {
        user.name = name;
      }

    
      if (password) {

        if (!oldPassword) {
          return res.status(400).json({
            success: false,
            message: "Old password is required to change password"
          });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);

        if (!isMatch) {
          return res.status(400).json({
            success: false,
            message: "Old password is incorrect"
          });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
      }

      await user.save();

      return res.status(200).json({
        success: true,
        code: "200",
        message: 'Your account updated successfully',
        data: {
          id: user._id,
          name: user.name,
          email: user.email
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

  module.exports = router;
