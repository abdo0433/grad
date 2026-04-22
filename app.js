const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Create uploads folder if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Routes
const authRoute           = require('./routes/auth');
const contactRoute        = require('./routes/contact');
const profileRoute        = require('./routes/profile');
const cvRoute             = require('./routes/cv');
const forgotpasswordRoute = require('./routes/forgotPassword');
const interviewRoutes     = require('./routes/interview');

app.use('/api', authRoute);
app.use('/api', contactRoute);
app.use('/api', profileRoute);
app.use('/api', cvRoute);
app.use('/api', forgotpasswordRoute);
app.use('/api', interviewRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});