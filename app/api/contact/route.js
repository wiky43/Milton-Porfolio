import axios from "axios";
import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

// Create and configure Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.GMAIL_PASSKEY,
  },
});

// Helper function to send a message via Telegram
async function sendTelegramMessage(token, chat_id, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await axios.post(url, {
      text: message,
      chat_id,
    });
    return res.data.ok;
  } catch (error) {
    console.error(
      "Error sending Telegram message:",
      error.response?.data || error.message,
    );
    return false;
  }
}

// HTML email template
const generateEmailTemplate = (name, email, userMessage) => `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; background-color: #f4f4f4;">
    <div style="max-width: 600px; margin: auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2 style="color: #007BFF;">New Message Received</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong></p>
      <blockquote style="border-left: 4px solid #007BFF; padding-left: 10px; margin-left: 0;">
        ${userMessage}
      </blockquote>
      <p style="font-size: 12px; color: #888;">Click reply to respond to the sender.</p>
    </div>
  </div>
`;

// Helper function to send an email via Nodemailer
async function sendEmail(payload, message) {
  const { name, email, message: userMessage } = payload;

  const mailOptions = {
    from: "Portfolio",
    to: process.env.EMAIL_ADDRESS,
    subject: `New Message From ${name}`,
    text: message,
    html: generateEmailTemplate(name, email, userMessage),
    replyTo: email,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error while sending email:", error.message);
    return false;
  }
}

// Simple in-memory rate limiter (not persistent across restarts/serverless invocations but better than nothing)
const rateLimit = new Map();

// Helper to check rate limit (windowMs: time window in ms, max: max requests per window)
const isRateLimited = (ip) => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const max = 5; // limit each IP to 5 requests per windowMs

  const requestLog = rateLimit.get(ip) || [];
  const recentRequests = requestLog.filter((time) => now - time < windowMs);

  if (recentRequests.length >= max) {
    return true;
  }

  recentRequests.push(now);
  rateLimit.set(ip, recentRequests);
  return false;
};

// Helper for email validation
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

async function sendToN8N(payload) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;

  if (!webhookUrl) {
    return { ok: false, message: "N8N webhook URL is missing." };
  }

  try {
    await axios.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    return { ok: true };
  } catch (error) {
    const status = error.response?.status;
    const n8nMessage = error.response?.data?.message || "";
    const isPostWebhookNotRegistered =
      status === 404 &&
      typeof n8nMessage === "string" &&
      n8nMessage.includes("POST") &&
      n8nMessage.toLowerCase().includes("not registered");
    const shouldTryTestWebhook =
      process.env.NODE_ENV !== "production" &&
      status === 404 &&
      webhookUrl.includes("/webhook/") &&
      n8nMessage.toLowerCase().includes("not registered");

    if (shouldTryTestWebhook) {
      const testWebhookUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
      try {
        await axios.post(testWebhookUrl, payload, {
          headers: { "Content-Type": "application/json" },
        });
        return { ok: true };
      } catch (testError) {
        console.error(
          "Error sending payload to n8n test webhook:",
          testError.response?.data || testError.message,
        );
      }
    }

    console.error(
      "Error sending payload to n8n:",
      error.response?.data || error.message,
    );
    if (isPostWebhookNotRegistered) {
      return {
        ok: false,
        message: "n8n webhook is not registered for POST.",
      };
    }

    return {
      ok: false,
      message: n8nMessage || "Failed to send payload to n8n webhook.",
    };
  }
}

export async function POST(request) {
  try {
    const ip = request.headers.get("x-forwarded-for") || "unknown";

    if (isRateLimited(ip)) {
      return NextResponse.json(
        {
          success: false,
          message: "Too many requests. Please try again later.",
        },
        { status: 429 },
      );
    }

    const payload = await request.json();
    const { name, email, message: userMessage } = payload;

    // Server-side validation
    if (!name || !email || !userMessage) {
      return NextResponse.json(
        {
          success: false,
          message: "Name, email, and message are required.",
        },
        { status: 400 },
      );
    }

    if (!isValidEmail(email)) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid email address.",
        },
        { status: 400 },
      );
    }

    if (userMessage.length > 1000) {
      return NextResponse.json(
        {
          success: false,
          message: "Message is too long (max 1000 characters).",
        },
        { status: 400 },
      );
    }

    let n8nSuccess = false;
    if (process.env.N8N_WEBHOOK_URL) {
      const n8nResult = await sendToN8N(payload);
      n8nSuccess = n8nResult.ok;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat_id = process.env.TELEGRAM_CHAT_ID;
    const message = `New message from ${name}\n\nEmail: ${email}\n\nMessage:\n\n${userMessage}\n\n`;

    // Send Telegram message if token and chat_id are present
    let telegramSuccess = false;
    if (token && chat_id) {
      telegramSuccess = await sendTelegramMessage(token, chat_id, message);
    }

    // Send email
    const emailSuccess = await sendEmail(payload, message);

    if (n8nSuccess || telegramSuccess || emailSuccess) {
      return NextResponse.json(
        {
          success: true,
          message: "Message sent successfully!",
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        message: "Failed to send message.",
      },
      { status: 500 },
    );
  } catch (error) {
    console.error("API Error:", error.message);
    return NextResponse.json(
      {
        success: false,
        message: "Server error occurred.",
      },
      { status: 500 },
    );
  }
}
