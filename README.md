# FormLens — Image to editable form fields

A **frontend-only** React **19.3.0**, TypeScript and Vite app. Your browser calls Groq directly using `qwen/qwen3.8-27b`. There is no application backend or API proxy.

## Run locally

Requires Node.js 24 or later and npm.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite serves only the frontend for development, not an extraction API. Production output is static files.

The Groq API key is read from the Vite environment variable `VITE_GROQ_API_KEY` and used automatically. Upload an image and extract without entering a key. There is no API key input or settings section in the UI. Copy `.env.example` to `.env` for local development, then set the key there.

Because this is a browser-only app, Vite replaces `VITE_GROQ_API_KEY` during the build and the resulting key is still present in production JavaScript and browser network requests. Visitors can retrieve it and use its Groq quota. Environment variables prevent committing the key to source control; they do not make a frontend key secret.

## Use

1. Choose or drag in a clear JPG, PNG, or WebP form image, up to **8 MiB**. PDFs and SVG uploads are not supported.
2. Click **Extract information** using the automatically configured key. Uploading alone makes no API request.
3. Review the **dynamic fields returned from your form**. Only fields with a readable filled-in value appear—there is no fixed personal/contact/address template. Original labels and section headings are preserved, including Bengali. Edit any value; multiline values remain editable.
4. Use the copy icon beside a field to copy only its current value, without its label or trailing whitespace. View the original transcription under **Raw text** and use **Copy raw text**, or download the edited fields as JSON or CSV.

**Try a demo** shows a fictional form and prepared local results without using Groq. To test real extraction, upload `public/sample-form.png` instead. No form data is persisted by this app; refreshing clears it. AI can misread printed or handwritten details, so review all results.

## Base64 → Groq flow

```text
Image file → browser FileReader.readAsDataURL(file)
           → direct browser POST to Groq chat/completions
           → image_url: "data:image/png;base64,..."
           → validated JSON → editable React fields
```

The browser request uses `response_format: { type: 'json_object' }` and `stream: false` so fields are populated only after complete JSON is validated, rather than from incomplete streaming chunks. The system prompt supports Bengali, English and mixed-language forms, preserving original Unicode text and Bengali digits without translating or guessing. Blank, unreadable and uncertain values are omitted from `fields`; uncertainty is reported in `warnings`. React also filters any empty or whitespace-only values the model returns. Explicitly filled answers such as `0`, `০`, `No`, `না` and `N/A` are not treated as blank.

`rawText` still contains all readable document text, including unfilled field labels. If no populated fields are found, the UI displays a helpful empty state and lets you review the transcription. Clearing a value while editing keeps its control visible so you can type a correction; exports reflect your edits.

`connection_address` and `operating_system` each occupy a full-width row. Within a section, NID number and Own are paired side by side, as are Mobile number and Alternative mobile number, with individual copy buttons. The prompt explicitly reads both mobile boxes independently, preserves leading zeros and Bengali digits, and does not merge or deduplicate their values. Extracted `Red` values have trailing whitespace removed.

Checkboxes and radio selections use the selected option's actual text, such as `Married` or `নারী`, as the editable value rather than a generic `Checked` state. A standalone `Own` option returned as `Checked` is normalized to its visible label, `Own`, before rendering or export. Multiple selected options appear on separate lines in document order. Unreadable selections are omitted with a warning rather than guessed.

Only filled-in text inputs and clearly marked selections belong in `fields`. Text inputs do not need tick marks, but checkbox/radio options must have a visible selection mark and readable option text. Blank inputs and unticked options remain only in `rawText`.

For repeatability, requests use `temperature: 0`, `top_p: 1`, and a fixed `seed: 42`. The prompt specifies a fixed reading order, a completeness/correctness check, and three examples covering both mobile numbers, blank inputs, address grouping, and selected versus unticked options. The same image produces the same request body. Groq describes seeded generation as best-effort deterministic; identical model output is not guaranteed, especially when the provider's backend changes. See the [Groq API reference](https://console.groq.com/docs/api-reference).

The extraction prompt uses input boundaries, rows, columns, and group labels to associate values. Blank fields must not borrow nearby values: an empty father's name stays omitted while populated connection address boxes remain under their own address label. Ambiguous pairings are omitted with a warning, preserving readable text in `rawText`.

`src/lib/groq.ts` makes one direct `fetch` request, passing the configured key in its Authorization header and the image in its JSON body:

```js
const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  credentials: 'omit',
  body: JSON.stringify({
    model: 'qwen/qwen3.8-27b',
    messages: [
      { role: 'system', content: extractionInstruction },
      { role: 'user', content: [
        { type: 'text', text: 'Extract the populated form fields and return JSON.' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] },
    ],
    response_format: { type: 'json_object' },
    stream: false,
  }),
});
```

Reference: [Groq vision and JSON-mode documentation](https://console.groq.com/docs/vision).

## Checks and production build

```sh
npm run lint
npm test          # Browser Groq client + React tests; mocked API calls only
npm run build    # TypeScript check and production bundle
npm start        # Previews static dist/ at http://127.0.0.1:5173
```

Deploy the generated `dist/` directory to any static HTTPS host. No Node process, Express server, API route, or proxy is needed in production. `npm start` is a local preview utility, not a required application backend.

Offline tests cover direct Groq request construction, authorization, Bengali Unicode/digits, blank-value filtering, dynamic fields, editing/export, timeouts, cancellation, validation and safe error messages. Groq's CORS preflight accepted POST with authorization/content-type headers from the development origin. No paid API request was repeated for this frontend-only migration; full live browser extraction still needs a manual check.

For a manual live check, set `VITE_GROQ_API_KEY`, upload `public/sample-form.png`, and extract. Expect nine populated fields including Alex Morgan, the email and postal code. This uses Groq API quota. The demo alone does not test live extraction.

## Security and deployment notes

- The key is read from `VITE_GROQ_API_KEY`; it is not persisted in browser storage or logged. Vite still embeds it in the production bundle because the browser calls Groq directly. Keep `.env` private and deploy it through Vercel's environment settings rather than committing it.
- Upload validation checks MIME type, base64 encoding, file signatures and decoded size. The model JSON is validated, response lengths are bounded, and CSV formula-like cells are neutralized.
- Requests have a 45-second timeout and cancellation, with no automatic retries. Groq enforces provider quotas and rate limits. There are no backend rate limits or private server credentials in this static architecture.
- Use HTTPS, a trusted static host, and appropriate deployment security headers. The embedded shared key is public, even though no key controls appear in the UI.
- Images intentionally go to Groq only for extraction. Understand Groq's data policies and obtain permission before uploading sensitive documents. This app does not claim provider-side deletion or zero retention.
- To change the fixed model, update `GROQ_MODEL` in `src/lib/groq.ts` to a Groq model supporting **images and JSON mode** and rebuild.
- If the browser/network blocks direct Groq access, the app reports a connection/CORS error. Do not disable browser security; check provider CORS support, extensions, network policies, and static-host Content-Security-Policy (`connect-src` must allow `https://api.groq.com`).

## Main files

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Environment-configured key, upload/base64, dynamic fields, copy/export |
| `src/styles.css` | Responsive interface |
| `src/lib/groq.ts` | System prompt, direct browser request, validation and safe errors |
| `src/lib/groq.test.ts`, `src/App.test.tsx` | Offline regression tests |
| `public/sample-form.png` | Fictional sample for real image extraction |
