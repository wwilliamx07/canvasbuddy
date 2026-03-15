const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const pptx2json = require('pptx2json');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.post('/pdf', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const filePath = path.join(__dirname, req.file.path);
  const dataBuffer = fs.readFileSync(filePath);
  try {
    const data = await pdfParse(dataBuffer);
    fs.unlinkSync(filePath);
    res.json({ text: data.text });
  } catch (err) {
    fs.unlinkSync(filePath);
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
