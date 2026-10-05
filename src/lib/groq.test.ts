import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractForm, GROQ_ENDPOINT, GROQ_MODEL, normalizeExtraction, validateImage } from './groq';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==';
const KEY = 'gsk_test_only_not_a_real_credential';
const data = {
  fields: [{ label: 'নাম', value: 'তানিয়া আক্তার', section: 'ব্যক্তিগত তথ্য' }],
  rawText: 'নাম: তানিয়া আক্তার\nফোন:',
  warnings: [],
};
const response = (content: unknown = data, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser Groq extraction', () => {
  it('sends a single direct request with the key only in its Authorization header', async () => {
    const result = await extractForm({ image: IMAGE, apiKey: ` ${KEY} ` });
    expect(result.fields[0]).toEqual({ id: 'field-1', ...data.fields[0] });
    expect(result.rawText).toBe(data.rawText);
    expect(result.model).toBe(GROQ_MODEL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(GROQ_ENDPOINT);
    expect(options?.method).toBe('POST');
    expect(options?.credentials).toBe('omit');
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` });
    const payload = JSON.parse(String(options?.body));
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[0].content).toContain('Bengali');
    expect(payload.messages[0].content).toContain('Omit blank');
    expect(payload.messages[1].content[1].image_url.url).toBe(IMAGE);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.stream).toBe(false);
    expect(JSON.stringify(payload)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('requires a key and a valid bounded image before contacting Groq', async () => {
    await expect(extractForm({ image: IMAGE, apiKey: '' })).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    await expect(extractForm({ image: IMAGE, apiKey: 'bad\nkey' })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    await expect(extractForm({ image: 'data:image/svg+xml;base64,PHN2Zz4=', apiKey: KEY })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(validateImage(IMAGE).mimeType).toBe('image/png');
    expect(() => validateImage(IMAGE.replace('image/png', 'image/jpeg'))).toThrow();
    expect(() => validateImage('data:image/png;base64,YQ===' )).toThrow();
    expect(() => validateImage(`data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`)).toThrow(/8 MiB/);
  });

  it('keeps the same low-randomness sampling settings, prompt and examples for repeated image requests', async () => {
    await extractForm({ image: IMAGE, apiKey: KEY });
    await extractForm({ image: IMAGE, apiKey: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({ temperature: 0, top_p: 1, seed: 42, stream: false });
    expect(payload.messages[0].content).toContain('Build fields in document order');
    const examples = JSON.parse(payload.messages[0].content.split('\n').at(-1));
    expect(examples).toHaveLength(3);
    expect(examples[0].fields.map((field: { label: string }) => field.label)).toEqual(['Mobile number', 'Alternative mobile number', 'NID number', 'Own']);
    expect(examples[1].fields.map((field: { label: string }) => field.label)).toEqual(['connection_address', 'Alternative mobile number', 'Rented']);
    expect(examples[2].fields.slice(0, 2).map((field: { value: string }) => field.value)).toEqual(['01700000000', '01700000000']);
  });

  it('instructs the model to preserve paired numeric values in one field', async () => {
    await extractForm({ image: IMAGE, apiKey: KEY });
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.messages[0].content).toContain('complete pair in that same field value');
    expect(payload.messages[0].content).toContain('22.847964589 and 89.545600');
    expect(payload.messages[0].content).toContain('22.847964, 89.545600');
    expect(payload.messages[0].content).toContain('Never keep only the first number');
    expect(payload.messages[0].content).toContain('never return only');
  });

  it('repairs a one-number Email coordinate value from the model raw transcription', () => {
    const result = normalizeExtraction({
      fields: [{ label: 'Email', value: '22.847964589', section: 'General' }],
      rawText: 'Email: 22.847964589, 89.545600',
      warnings: [],
    });
    expect(result.fields[0].value).toBe('22.847964, 89.545600');
    expect(normalizeExtraction({
      fields: [{ label: 'Email', value: '22.847964589', section: 'General' }],
      rawText: 'Email: 22.847964589',
      warnings: [],
    }).fields[0].value).toBe('22.847964');
  });

  it('omits empty values, retains Bengali digits and literal negative answers, and removes arbitrary properties', () => {
    const result = normalizeExtraction({
      ...data,
      fields: [
        { label: 'নাম', value: '  তানিয়া আক্তার  ', section: 'ব্যক্তিগত তথ্য', id: 'untrusted', secret: 'omit' },
        { label: 'ঠিকানা', value: 'ঢাকা\nবাংলাদেশ', section: '' },
        ...['0', '০', 'No', 'না', 'N/A'].map((value) => ({ label: 'Answer', value })),
        ...['', ' ', '\t\r\n', '\u00a0', '\u0000'].map((value) => ({ label: 'Blank', value })),
      ],
      warnings: ['Review', 'Review', ''],
    });
    expect(result.fields).toHaveLength(7);
    expect(result.fields[0]).toEqual({ id: 'field-1', label: 'নাম', value: '  তানিয়া আক্তার  ', section: 'ব্যক্তিগত তথ্য' });
    expect(result.fields[1].value).toBe('ঢাকা\nবাংলাদেশ');
    expect(result.fields[1].section).toBe('General');
    expect(result.fields.slice(2).map((field) => field.value)).toEqual(['0', '০', 'No', 'না', 'N/A']);
    expect(result.warnings).toEqual(['Review']);
    expect(new Set(result.fields.map((field) => field.id)).size).toBe(7);
    expect(normalizeExtraction({ fields: [{ label: 'Empty', value: ' ' }], rawText: 'Empty:' }).warnings[0]).toMatch(/No populated/);
  });

  it('uses the Own option text when Groq returns a generic Checked value without changing unrelated answers', () => {
    const result = normalizeExtraction({
      ...data,
      fields: [
        { label: 'Own', value: 'Checked' },
        { label: 'OWN', value: ' checked ' },
        { label: 'Own', value: '  Own  ' },
        { label: 'Own', value: 'No' },
        { label: 'Own', value: '' },
        { label: 'Inspection status', value: 'Checked' },
      ],
    });
    expect(result.fields.map((field) => field.value)).toEqual(['Own', 'OWN', '  Own  ', 'No', 'Checked']);
    expect(result.rawText).toBe(data.rawText);
  });

  it('joins the Red color code without an inserted space', () => {
    const result = normalizeExtraction({
      ...data,
      fields: [{ label: 'Color code', value: 'Red 5295', section: 'General' }],
    });
    expect(result.fields[0].value).toBe('Red5295');
    expect(normalizeExtraction({
      ...data,
      fields: [{ label: 'Color code', value: 'Blue 5295', section: 'General' }],
    }).fields[0].value).toBe('Blue 5295');
    expect(normalizeExtraction({
      ...data,
      fields: [{ label: 'Color code', value: 'Red 5295\n\n@Sohel', section: 'General' }],
    }).fields[0].value).toBe('Red5295\n\n@Sohel');
  });

  it('validates every model field, bounded lengths and JSON structure', () => {
    for (const invalid of ['not JSON', { fields: [], rawText: 42 }, { fields: [{ label: 'Age', value: 20 }], rawText: '' }, { fields: [{ label: '', value: '' }], rawText: '' }, { ...data, warnings: [123] }, { ...data, fields: Array(201).fill(data.fields[0]) }, { ...data, rawText: 'x'.repeat(100_001) }]) {
      expect(() => normalizeExtraction(invalid)).toThrow(/unreadable extraction/);
    }
  });

  it.each([
    [401, 'PROVIDER_AUTH_ERROR'], [403, 'PROVIDER_AUTH_ERROR'],
    [402, 'PROVIDER_QUOTA_EXCEEDED'], [429, 'PROVIDER_RATE_LIMIT'],
    [400, 'PROVIDER_REQUEST_ERROR'], [500, 'PROVIDER_UNAVAILABLE'], [504, 'EXTRACTION_TIMEOUT'],
  ])('maps HTTP %s to safe error %s without retries or leaked payloads', async (status, code) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: `Sensitive ${KEY}` }), { status }));
    await expect(extractForm({ image: IMAGE, apiKey: KEY })).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles network/CORS failures without echoing raw errors', async () => {
    fetchMock.mockRejectedValue(new Error(`Sensitive ${KEY}`));
    await expect(extractForm({ image: IMAGE, apiKey: KEY })).rejects.toMatchObject({ code: 'PROVIDER_CONNECTION_ERROR', message: expect.stringContaining('CORS') });
  });

  it.each(['length', 'content_filter'])('rejects model finish reason %s', async (finish) => {
    fetchMock.mockResolvedValue(response(data, finish));
    await expect(extractForm({ image: IMAGE, apiKey: KEY })).rejects.toMatchObject({ code: 'INVALID_EXTRACTION' });
  });

  it('rejects malformed completion and model JSON', async () => {
    for (const reply of [new Response('not json'), new Response('{}'), response('not model JSON')]) {
      fetchMock.mockResolvedValue(reply);
      await expect(extractForm({ image: IMAGE, apiKey: KEY })).rejects.toMatchObject({ code: 'INVALID_EXTRACTION' });
    }
  });

  it('propagates cancellation and does not start an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractForm({ image: IMAGE, apiKey: KEY, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    const active = new AbortController();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const promise = extractForm({ image: IMAGE, apiKey: KEY, signal: active.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    active.abort();
    await assertion;
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('times out one stalled request after 45 seconds and aborts it', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const promise = extractForm({ image: IMAGE, apiKey: KEY });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'EXTRACTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
