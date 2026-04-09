export default async function generateImage(input) {
  const { prompt, aspect_ratio = '1:1', size = '1K' } = input;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'GEMINI_API_KEY environment variable is not set' };
  }

  const outboundDir = process.env.CCBUDDY_OUTBOUND_DIR;
  if (!outboundDir) {
    throw new Error('CCBUDDY_OUTBOUND_DIR is not set for this request');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`;

  const body = {
    contents: [{
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspect_ratio,
        imageSize: size,
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `Gemini API error (${response.status}): ${text.slice(0, 500)}` };
  }

  const data = await response.json();

  const candidate = data.candidates?.[0];
  if (!candidate) {
    return { success: false, error: 'No candidates in Gemini response' };
  }

  const parts = candidate.content?.parts ?? [];
  let textResult = '';
  let imageData = null;
  let imageMimeType = 'image/png';

  for (const part of parts) {
    if (part.text) {
      textResult += part.text;
    }
    const inlineData = part.inline_data || part.inlineData;
    if (inlineData) {
      imageData = inlineData.data;
      imageMimeType = inlineData.mime_type || inlineData.mimeType || 'image/png';
    }
  }

  if (!imageData) {
    return {
      success: true,
      result: textResult || 'Gemini returned no image. The prompt may have been filtered.',
    };
  }

  // Write image to temp file instead of passing base64 through MCP pipeline
  // (550KB+ of base64 in a JSON tool result chokes the agent)
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');

  try { mkdirSync(outboundDir, { recursive: true }); } catch {}

  const ext = imageMimeType === 'image/jpeg' ? 'jpg' : 'png';
  const filename = `generated-${randomUUID().slice(0, 8)}.${ext}`;
  const filePath = join(outboundDir, filename);
  writeFileSync(filePath, Buffer.from(imageData, 'base64'));

  return {
    success: true,
    result: textResult || `Generated image for: ${prompt}`,
    media: [{
      filePath,
      mimeType: imageMimeType,
      filename,
    }],
  };
}
