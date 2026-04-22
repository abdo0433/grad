const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');

router.post('/forgotpassword', async (req, res) => {
  try {
    const { email, newpassword } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with this email'
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newpassword, salt);
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (error) {
    return res.status(400).json({
      success: false,
      message: 'Something went wrong while updating your password'
    });
  }
});

module.exports = router;