import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  base_url: "https://vjioo4r1vyvcozuj.us-east-2.aws.endpoints.huggingface.cloud/v1"
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Canvas Buddy Server is running' });
});

// Generate endpoint - relay to OpenAI
app.post('/generate', async (req, res) => {
  try {
    const { messages, model = , maxTokens = 1000 } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: 'Invalid request: messages array is required',
      });
    }

    // Call OpenAI API
    const response = await openai.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      max_tokens: 5000,
    });

    // Extract the response text
    const text = response.choices[0].message.content;

    // Return the response
    res.json({
      success: true,
      content: text,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
    });
  } catch (error) {
    console.error('OpenAI API Error:', error);

    // Handle specific OpenAI errors
    if (error instanceof OpenAI.APIError) {
      return res.status(error.status || 500).json({
        error: error.message,
        type: error.type,
        code: error.code,
      });
    }

    // Handle other errors
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({
    error: 'Server error',
    message: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Canvas Buddy Server is running on http://localhost:${PORT}`);
});
