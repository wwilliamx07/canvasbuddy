const express = require('express');
const pdfParse = require('pdf-parse');
const pptx2json = require('pptx2json');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');

const app = express();

app.use(express.json());

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  // Extract file extension from URL
  const urlPath = new URL(url, 'http://dummy').pathname;
  const fileExtension = path.extname(urlPath).toLowerCase();

  // Validate file extension
  if (fileExtension !== '.pdf' && fileExtension !== '.pptx') {
    return res.status(400).json({ error: 'Invalid file type. Only PDF and PPTX files are supported.' });
  }

  try {
    let dataBuffer;
    if (url.startsWith('file:///')) {
      // Handle local file path
      const filePath = url.replace('file:///', '').replace(/\//g, path.sep);
      dataBuffer = fs.readFileSync(filePath);
    } else {
      // Handle http/https URLs
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      dataBuffer = Buffer.from(response.data);
    }

    let text = '';

    if (fileExtension === '.pdf') {
      // Extract text from PDF
      const data = await pdfParse(dataBuffer);
      text = data.text;
    } else if (fileExtension === '.pptx') {
      // Extract text from PPTX
      const tempFile = path.join(__dirname, 'uploads', `temp_${Date.now()}.pptx`);
      fs.writeFileSync(tempFile, dataBuffer);
      try {
        const result = await pptx2json(tempFile);
        // pptx2json returns an object with slides and shapes, extract text
        if (result && result.slides) {
          result.slides.forEach(slide => {
            if (slide.shapes) {
              slide.shapes.forEach(shape => {
                if (shape.text) {
                  text += shape.text + '\n';
                }
              });
            }
          });
        }
      } finally {
        fs.unlinkSync(tempFile);
      }
    }

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract text from file' });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});

