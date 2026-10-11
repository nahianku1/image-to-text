import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { img2txt } = vi.hoisted(() => ({ img2txt: vi.fn() }));

import { extractForm, normalizeExtraction, PUTER_MODEL, PUTER_PROVIDER, validateImage } from './puter';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==';
const data = {
  fields: [{ label: 'নাম', value: 'তানিয়া আক্তার', section: 'ব্যক্তিগত তথ্য' }],
  rawText: 'নাম: তানিয়া আক্তার\nফোন:',
  warnings: [],
};

beforeEach(() => {
  img2txt.mockReset();
  img2txt.mockResolvedValue(JSON.stringify(data));
  vi.stubGlobal('puter', { ai: { img2txt } });
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Puter OCR extraction', () => {
  it('calls Puter img2txt with the image data URI and structured annotation options', async () => {
    const result = await extractForm({ image: IMAGE });
    expect(result.fields[0]).toEqual({ id: 'field-1', ...data.fields[0] });
    expect(result.model).toBe(PUTER_MODEL);
    expect(img2txt).toHaveBeenCalledTimes(1);
    const [image, options] = img2txt.mock.calls[0];
    expect(image).toBe(IMAGE);
    expect(options).toMatchObject({ model: PUTER_MODEL, provider: PUTER_PROVIDER, testMode: false });
    expect(options.documentAnnotationPrompt).toContain('Bengali');
    expect(options.documentAnnotationPrompt).toContain('Omit blank');
    expect(options.documentAnnotationFormat).toMatchObject({ type: 'json_schema', json_schema: { name: 'form_extraction' } });
    expect(options.documentAnnotationFormat.json_schema.schema.required).toEqual(['fields', 'rawText', 'warnings']);
  });

  it('validates bounded JPEG, PNG and WebP data URIs before Puter', async () => {
    expect(validateImage(IMAGE).mimeType).toBe('image/png');
    await expect(extractForm({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(extractForm({ image: 'data:image/png;base64,YQ===' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(img2txt).not.toHaveBeenCalled();
    expect(() => validateImage(IMAGE.replace('image/png', 'image/jpeg'))).toThrow();
    expect(() => validateImage(`data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`)).toThrow(/8 MiB/);
  });

  it('keeps Bengali text/digits and explicit zero or negative answers, while omitting blanks', () => {
    const result = normalizeExtraction({
      fields: [
        { label: 'নাম', value: '  তানিয়া আক্তার  ', section: 'ব্যক্তিগত তথ্য' },
        { label: 'ফোন', value: '০১৭১২৩৪৫৬৭৮', section: 'যোগাযোগ' },
        ...['0', '০', 'No', 'না', 'N/A'].map((value) => ({ label: 'Answer', value })),
        ...['', ' ', '\t\r\n', '\u0000'].map((value) => ({ label: 'Blank', value })),
      ],
      rawText: 'নাম: তানিয়া আক্তার\nBlank:',
      warnings: ['Review', 'Review', ''],
    });
    expect(result.fields).toHaveLength(7);
    expect(result.fields[0].value).toBe('  তানিয়া আক্তার  ');
    expect(result.fields[1].value).toBe('০১৭১২৩৪৫৬৭৮');
    expect(result.fields.slice(2).map((field) => field.value)).toEqual(['0', '০', 'No', 'না', 'N/A']);
    expect(result.warnings).toEqual(['Review']);
  });

  it('rejects malformed or oversized model results safely', () => {
    for (const invalid of ['not JSON', { fields: [], rawText: 42 }, { fields: [{ label: 'Age', value: 20 }], rawText: '' }, { fields: [{ label: '', value: '' }], rawText: '' }, { fields: [], rawText: 'x'.repeat(100_001) }]) {
      expect(() => normalizeExtraction(invalid)).toThrow(/unreadable extraction/);
    }
  });

  it('maps Puter errors without exposing provider payloads', async () => {
    for (const [code, expected] of [['input_too_large', 'IMAGE_TOO_LARGE'], ['bad_request', 'PROVIDER_REQUEST_ERROR'], ['insufficient_funds', 'PROVIDER_QUOTA_EXCEEDED'], ['upstream_error', 'PROVIDER_UNAVAILABLE']]) {
      img2txt.mockRejectedValueOnce(Object.assign(new Error('private payload'), { code }));
      await expect(extractForm({ image: IMAGE })).rejects.toMatchObject({ code: expected });
    }
  });

  it('propagates cancellation and does not start an already-cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractForm({ image: IMAGE, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(img2txt).not.toHaveBeenCalled();
    const active = new AbortController();
    img2txt.mockImplementation(() => new Promise(() => {}));
    const promise = extractForm({ image: IMAGE, signal: active.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    active.abort();
    await assertion;
  });

  it('times out one stalled Puter call after 45 seconds', async () => {
    vi.useFakeTimers();
    img2txt.mockImplementation(() => new Promise(() => {}));
    const promise = extractForm({ image: IMAGE });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'EXTRACTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains raw text even when no populated fields exist', async () => {
    img2txt.mockResolvedValue(JSON.stringify({ fields: [{ label: 'ফোন', value: ' ', section: 'যোগাযোগ' }], rawText: 'ফোন:', warnings: [] }));
    const result = await extractForm({ image: IMAGE });
    expect(result.fields).toEqual([]);
    expect(result.rawText).toBe('ফোন:');
    expect(result.warnings[0]).toMatch(/No populated/);
  });
});
