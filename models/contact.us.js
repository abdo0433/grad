const mongoose = require('mongoose');

const contactusSchema = new mongoose.Schema({

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  comment: {
    type: String,
  
  }
}, 
);

module.exports = mongoose.model('Contact', contactusSchema);