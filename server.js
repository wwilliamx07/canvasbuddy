const express = require('express');
const pdfParse = require('pdf-parse');
const pptx2json = require('pptx2json');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const app = express();

app.use(express.json());

app.post('/pdf', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
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
    const data = await pdfParse(dataBuffer);
    res.json({ text: data.text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract PDF text' });
  }
});

app.post('/pptx', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const filePath = path.join(__dirname, req.file.path);
  try {
    const result = await pptx2json(filePath);
    fs.unlinkSync(filePath);
    // pptx2json returns an object with slides and shapes, extract text
    let text = '';
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
    res.json({ text });
  } catch (err) {
    fs.unlinkSync(filePath);
    res.status(500).json({ error: 'Failed to extract PPTX text' });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});

