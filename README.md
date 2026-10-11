# FormLens — Image to editable form fields

FormLens is a frontend-only React 19.3 + TypeScript + Vite app. It uses **Puter.js OCR** from the official browser CDN to read uploaded form images, preserving Bengali, English, mixed-language text and dynamic form fields.

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite serves the static frontend; there is no Express server, application API route, API proxy or application secret.

Puter.js handles authentication, usage and provider access. The app does not ask for or bundle a provider API key. Depending on Puter’s auth state and deployment, Puter may prompt the user to sign in or approve access.

## Use

1. Choose or drag in one clear JPG, PNG or WebP form image, up to **8 MiB**. PDFs and SVG uploads are not supported.
2. Click **Extract with Puter**. Uploading alone does not send the image.
3. Review the **dynamic fields returned from the form**. Only fields with readable, visibly filled values appear; there is no fixed personal/contact/address template.
4. Original labels and section headings are preserved, including Bengali Unicode and Bengali digits. Edit values, view `rawText`, copy, or download JSON/CSV.

**Try a demo** shows a fictional form and local prepared results without calling Puter. No form data is persisted by this app; refreshing clears the workspace. Review OCR output before using it.

## Puter.js image extraction

The app uses the documented `puter.ai.img2txt()` structured annotation API:

```ts
const annotation = await puter.ai.img2txt(imageDataUrl, {
  model: 'mistral-ocr-latest',
  provider: 'mistral',
  documentAnnotationPrompt: extractionInstruction,
  documentAnnotationFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'form_extraction',
      schema: formExtractionSchema,
    },
  },
  testMode: false,
});
```

`index.html` loads `https://js.puter.com/v2/`, which provides the browser `puter` global. Puter documents that `img2txt()` accepts a data URI and returns a string. FormLens validates that data URI locally before calling Puter, including canonical base64, MIME/signature consistency and an 8 MiB limit. The client adds a 45-second timeout and guards against stale results when the image is replaced or removed.

The extraction prompt instructs the OCR model to:

- Read printed and handwritten Bengali, English and mixed-language forms.
- Preserve original labels, values, Unicode, Bengali digits, spelling and line breaks without translation or transliteration.
- Return only fields with actual visible values; omit blank, unreadable, uncertain, placeholder, example and unticked-option values.
- Keep explicit values such as `0`, `০`, `No`, `না` and `N/A` when they are visibly filled answers.
- Keep all readable document text—including blank labels—in `rawText`.
- Avoid copying a value from a neighboring field or inventing missing data.

If no populated fields are found, the UI shows a useful empty state while preserving the raw transcription.

Official references: [Puter.js getting started](https://docs.puter.com/getting-started/), [`puter.ai.img2txt()`](https://docs.puter.com/AI/img2txt/), and [structured `puter.ai.chat()` responses](https://docs.puter.com/AI/chat/).

## Checks and production build

```sh
npm run lint
npm test          # Mocked Puter + React tests; no live API calls
npm run build     # TypeScript check and production bundle
npm start         # Local static preview at http://127.0.0.1:5173
```

Deploy the generated `dist/` directory to any static HTTPS host. No Node API process is required in production. The deployed site needs access to Puter.js and Puter’s services; check the host Content-Security-Policy if you add one.

No paid/live Puter request was made during this migration. For a manual test, run the app, sign in to Puter if prompted, upload `public/sample-form.png`, and click **Extract with Puter**.

## Main files

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Upload, preview, dynamic editable fields, raw text, copy and export |
| `src/lib/puter.ts` | Puter.js global OCR call, annotation schema, Bengali prompt, validation and safe errors |
| `src/lib/puter.test.ts` | Puter client regression tests with mocked SDK |
| `src/App.test.tsx` | React upload, dynamic-field and editing tests |
| `src/styles.css` | Responsive FormLens interface |
| `public/sample-form.png` | Fictional sample form |
