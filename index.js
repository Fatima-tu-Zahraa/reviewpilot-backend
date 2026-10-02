const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(require('cors')());

app.set('trust proxy', 1);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again after 15 minutes.' },
});

 
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signups from this device. Please try again later.' },
});

 
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in an hour.' },
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => console.error('MongoDB connection error:', err.message));

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true, unique: true },
  password: String,
  resetToken: String,
  resetTokenExpiry: Date,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
 

const reviewSchema = new mongoose.Schema({
  repoName: String,
  prNumber: Number,
  prTitle: String,
  reviewText: String,
  falseAlarm: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const Review = mongoose.model('Review', reviewSchema);

 

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

 

function verifyGithubSignature(req, res, next) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('GITHUB_WEBHOOK_SECRET is not set in .env');
    return res.status(500).send('Server misconfigured');
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) {
    console.log('Webhook rejected: no signature');
    return res.status(401).send('No signature');
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.log('Webhook rejected: invalid signature');
    return res.status(401).send('Invalid signature');
  }

  next();
}

 
async function sendResetEmail(toEmail, resetLink) {
  await axios.post(
    'https://api.resend.com/emails',
    {
      from: 'ReviewPilot <onboarding@resend.dev>', // Resend ka free/test sender
      to: toEmail,
      subject: 'Reset your ReviewPilot password',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Reset your password</h2>
          <p>You requested a password reset for your ReviewPilot account.</p>
          <p>
            <a href="${resetLink}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">
              Reset Password
            </a>
          </p>
          <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}
 

function generateJWT() {
  let privateKey;

  if (process.env.GITHUB_PRIVATE_KEY) {
    // Render / production
    privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    // Local development
    privateKey = fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8');
  }

  const payload = {
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + (9 * 60),
    iss: process.env.APP_ID,
  };

  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

async function getInstallationToken(installationId) {
  const appJWT = generateJWT();
  const response = await axios.post(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {},
    {
      headers: {
        Authorization: `Bearer ${appJWT}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  return response.data.token;
}

async function postComment(owner, repo, prNumber, token, commentBody) {
  await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body: commentBody },
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

async function reviewWithGemini(diffText, retriesPerModel = 2) {
  const prompt = `You are a senior code reviewer. Review the following code diff.
Point out bugs, security issues, or bad practices. Keep it short and clear, in bullet points.
If everything looks fine, just say "No major issues found."

Diff:
${diffText}`;

  let lastError;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    for (let attempt = 1; attempt <= retriesPerModel; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });

        if (!response.ok) {
          const errText = await response.text();
          const err = new Error(`Gemini API error (${model}): ${response.status} - ${errText.slice(0, 200)}`);
          err.status = response.status;
          throw err;
        }

        const data = await response.json();
        console.log(`Review generated using ${model}`);
        return data.candidates[0].content.parts[0].text;
      } catch (err) {
        lastError = err;
        console.log(`${model} failed (attempt ${attempt}/${retriesPerModel}):`, err.message);
        if (err.status === 404) break; // ye model hai hi nahi, seedha agla try karo
        if (attempt < retriesPerModel) await sleep(3000);
      }
    }

    console.log(`Switching to next model...`);
  }

  throw lastError;
}

 

app.post('/api/auth/signup', signupLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { name: user.name, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { name: user.name, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

 
app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
 
    if (!user) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetToken = resetToken;
    user.resetTokenExpiry = Date.now() + 60 * 60 * 1000; // 1 ghanta
    await user.save();

    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
    await sendResetEmail(user.email, resetLink);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

 
app.post('/api/auth/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;

    const user = await User.findOne({
      resetToken: token,
      resetTokenExpiry: { $gt: Date.now() }, // token expire to nahi hua
    });

    if (!user) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: 'Password reset successful. You can now sign in.' });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

 

app.get('/', (req, res) => {
  res.send('ReviewPilot backend is running');
});

app.get('/api/reviews', verifyToken, async (req, res) => {
  try {
    const reviews = await Review.find().sort({ createdAt: -1 });
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.get('/api/reviews/:id', verifyToken, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch review' });
  }
});

 
app.patch('/api/reviews/:id/false-alarm', verifyToken, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });

    review.falseAlarm = !review.falseAlarm;
    await review.save();

    res.json(review);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

 
app.post('/webhook', verifyGithubSignature, async (req, res) => {
  console.log('Webhook received');
 
  res.status(200).send('Received');

  const { action, pull_request, installation } = req.body;

  if (action === 'opened' && pull_request) {
    console.log('PR title:', pull_request.title);

    try {
      const token = await getInstallationToken(installation.id);

      const diffResponse = await axios.get(
        `https://api.github.com/repos/${req.body.repository.full_name}/pulls/${pull_request.number}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3.diff',
          },
        }
      );

      const review = await reviewWithGemini(diffResponse.data);
      console.log('Review generated');

      const commentBody = `🤖 **ReviewPilot AI Review**\n\n${review}`;

      await postComment(
        req.body.repository.owner.login,
        req.body.repository.name,
        pull_request.number,
        token,
        commentBody
      );

      await Review.create({
        repoName: req.body.repository.full_name,
        prNumber: pull_request.number,
        prTitle: pull_request.title,
        reviewText: review,
      });

      console.log('Comment posted and review saved');

    } catch (error) {
      console.error('Error:', error.response?.data || error.message, error.cause || '');
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});