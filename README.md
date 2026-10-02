# ReviewPilot

An AI-powered Pull Request reviewer. When a pull request is opened on a connected GitHub repository, ReviewPilot reads the code diff, asks Google Gemini to review it, and posts the review as a comment on the PR. Every review is also saved and shown on a web dashboard.

## Features

- **Automatic AI reviews**: a GitHub App webhook triggers a review on every new pull request
- **Gemini with fallback**: if one Gemini model is busy or unavailable, the server retries and switches to a backup model
- **Review dashboard**: see all reviews per repository, open a review for details, and mark a review as a false alarm
- **Authentication**: signup and login with JWT, protected routes on both frontend and backend
- **Password reset**: forgot password flow with an emailed reset link (Resend)
- **Security**
  - GitHub webhook signature verification (HMAC SHA-256) so fake requests are rejected
  - Rate limiting on login, signup and password reset
  - Passwords hashed with bcrypt
  - Secrets kept in `.env` (never committed)

## How it works

```
Pull request opened on GitHub
        |
        v
GitHub App webhook  -->  POST /webhook  (signature verified)
        |
        v
Server gets a GitHub installation token and fetches the PR diff
        |
        v
Gemini reviews the diff (with retries and model fallback)
        |
        v
Review is posted as a PR comment and saved in MongoDB
        |
        v
Review appears on the React dashboard
```

## Tech stack

| Part | Technology |
|------|------------|
| Backend | Node.js, Express |
| Database | MongoDB (Mongoose) |
| AI | Google Gemini API |
| GitHub integration | GitHub App (webhooks, installation tokens) |
| Email | Resend |
| Frontend | React, Vite, Tailwind CSS, React Router, Axios |
| Auth | JWT, bcryptjs |

## Project structure

```
reviewpilot-backend/    Express server, webhook, auth, reviews API
reviewpilot-frontend/   React dashboard (Vite)
```

## Getting started

### Prerequisites

- Node.js 18 or newer
- A MongoDB database (for example MongoDB Atlas)
- A Google Gemini API key
- A GitHub App (see below)
- A Resend API key (for password reset emails)
- [ngrok](https://ngrok.com/) to expose your local server to GitHub during development

### 1. Create the GitHub App

1. Go to GitHub Settings, Developer settings, GitHub Apps, New GitHub App
2. Set the **Webhook URL** to `https://YOUR-NGROK-URL/webhook`
3. Set a **Webhook secret** (a long random string, you will reuse it in `.env`)
4. Permissions: **Pull requests: Read and write**, **Contents: Read-only**
5. Subscribe to the **Pull request** event
6. Generate a **private key** and save it as `private-key.pem` in the backend folder
7. Install the app on the repositories you want reviewed

### 2. Backend setup

```bash
cd reviewpilot-backend
npm install
```

Create a `.env` file:

```env
APP_ID=your_github_app_id
PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GEMINI_API_KEY=your_gemini_api_key
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=a_long_random_string
RESEND_API_KEY=your_resend_api_key
FRONTEND_URL=http://localhost:5173
```

Generate a strong random secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
node index.js
```

In a second terminal, expose it to GitHub:

```bash
ngrok http 3000
```

### 3. Frontend setup

```bash
cd reviewpilot-frontend
npm install
npm run dev
```

The app runs at `http://localhost:5173`. By default it talks to `http://localhost:3000`. To point it somewhere else, create a `.env` file in the frontend folder:

```env
VITE_API_URL=https://your-backend-url
```

### 4. Try it

1. Open the dashboard, sign up and log in
2. Open a new pull request on a repository where the app is installed
3. Within a minute the AI review appears as a comment on the PR and on the dashboard

## API overview

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/signup` | Create an account |
| POST | `/api/auth/login` | Log in, returns a JWT |
| POST | `/api/auth/forgot-password` | Email a password reset link |
| POST | `/api/auth/reset-password` | Set a new password with a reset token |
| GET | `/api/reviews` | List reviews (login required) |
| GET | `/api/reviews/:id` | Get one review (login required) |
| PATCH | `/api/reviews/:id/false-alarm` | Toggle false alarm (login required) |
| POST | `/webhook` | GitHub webhook (signature verified) |

## Notes

- Never commit `.env` or `private-key.pem`. Both are listed in `.gitignore`.
- Resend's free test sender (`onboarding@resend.dev`) only delivers to your own Resend account email until you verify a domain.
- Reviews are only generated for the `opened` pull request action.
- The free ngrok address can change when ngrok restarts. If it does, update the Webhook URL in your GitHub App settings.

## Author

Built by Fatima.
