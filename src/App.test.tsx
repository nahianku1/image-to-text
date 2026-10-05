import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { GROQ_ENDPOINT } from './lib/groq';

const result = {
  fields: [
    { id: 'field-1', label: 'Applicant name', value: 'Sam Rivera', section: 'Applicant' },
    { id: 'field-2', label: 'Email', value: 'sam@example.com', section: 'Contact' },
    { id: 'field-3', label: 'Membership number', value: '00142', section: 'Membership' },
  ],
  rawText: 'Applicant name: Sam Rivera\nEmail: sam@example.com\nMembership number: 00142',
  warnings: ['Review handwriting.'],
  model: 'qwen/qwen3.8-27b',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] } : body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json(result));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  });
});

afterEach(() => vi.unstubAllGlobals());

async function upload(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Upload a form image'), new File([Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0))], 'registration.png', { type: 'image/png' }));
  await screen.findByAltText('Uploaded form to extract');
}

describe('FormLens user flow', () => {
  it('starts with no predefined fields and no extraction or export enabled', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Extract information' })).toBeDisabled();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('demo is local, explicit, editable and includes matching raw text', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try a demo' }));
    expect(screen.getByText("You're exploring the demo.")).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'Full name' });
    expect(name).toHaveValue('Alex Morgan');
    await user.clear(name);
    await user.type(name, 'Edited Demo');
    expect(name).toHaveValue('Edited Demo');
    await user.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByText(/Full name: Alex Morgan/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads base64 only on extract and renders exactly the returned labels and sections', async () => {
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Applicant name' })).toHaveValue('Sam Rivera'));
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('sam@example.com');
    expect(screen.getByRole('textbox', { name: 'Membership number' })).toHaveValue('00142');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Applicant' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Full name' })).not.toBeInTheDocument();
    expect(screen.getByText('Review handwriting.')).toBeInTheDocument();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(GROQ_ENDPOINT);
    const authorization = (options?.headers as Record<string, string>).Authorization;
    expect(authorization.startsWith('Bearer gsk_')).toBe(true);
    const payload = JSON.parse(String(options?.body));
    expect(payload.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(payload.messages[0].role).toBe('system');
    expect(JSON.stringify(payload).includes(authorization.slice('Bearer '.length))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: 'Membership number' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('rejects unsupported and oversized uploads locally', async () => {
    render(<App />);
    const input = screen.getByLabelText('Upload a form image');
    fireEvent.change(input, { target: { files: [new File(['pdf'], 'form.pdf', { type: 'application/pdf' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a JPG');
    const file = new File(['x'], 'large.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 8 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent('too large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts with the configured key without showing API key controls or using browser storage', async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear API key' })).not.toBeInTheDocument();
    await upload(user);
    expect(screen.getByRole('button', { name: 'Extract information' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    await screen.findByRole('textbox', { name: 'Applicant name' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization.startsWith('Bearer gsk_')).toBe(true);
    expect(localStorage.getItem('GROQ_API_KEY')).toBeNull();
    expect(sessionStorage.getItem('GROQ_API_KEY')).toBeNull();
    view.unmount();
    render(<App />);
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows service failures without fabricated results', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Sensitive provider payload' }, 429));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('rate limit');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('ignores stale extraction after the image is removed', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    await user.click(screen.getByRole('button', { name: 'Remove image' }));
    await act(async () => { resolve(json(result)); });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('exports edited values to JSON and spreadsheet-safe CSV', async () => {
    const blobs: Blob[] = [];
    const nativeURL = URL;
    vi.stubGlobal('URL', class extends nativeURL {
      static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:test'; }
      static revokeObjectURL() { /* No resource is allocated in this test. */ }
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const readBlob = (blob: Blob) => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try a demo' }));
    const name = screen.getByRole('textbox', { name: 'Full name' });
    await user.clear(name);
    await user.type(name, '=EDITED');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await user.click(screen.getByRole('button', { name: /Download JSON/ }));
    const exported = JSON.parse(await readBlob(blobs[0]));
    expect(exported.fields.find((field: { id: string }) => field.id === 'full-name').value).toBe('=EDITED');
    expect(exported.mode).toBe('demo');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    expect(await readBlob(blobs[1])).toContain('"\'=EDITED"');
  });

  it('copies only an individual field current value without its label or trailing spaces', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try a demo' }));
    const name = screen.getByRole('textbox', { name: 'Full name' });
    await user.clear(name);
    await user.type(name, 'Edited Person   ');
    await user.click(screen.getByRole('button', { name: 'Copy Full name value' }));
    expect(writeText).toHaveBeenCalledWith('Edited Person');
    expect(screen.getByText('Full name copied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    await user.clear(name);
    expect(screen.getByRole('button', { name: 'Copy Full name value' })).toBeDisabled();
  });

  it('copies raw text explicitly and reports a field clipboard failure', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard unavailable'));
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try a demo' }));
    await user.click(screen.getByRole('button', { name: 'Copy Full name value' }));
    expect(screen.getByText('Copy unavailable. Select the field value to copy it manually.')).toBeInTheDocument();
    writeText.mockResolvedValue();
    await user.click(screen.getByRole('tab', { name: 'Raw text' }));
    await user.click(screen.getByRole('button', { name: 'Copy raw text' }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Full name: Alex Morgan'));
  });

  it('pairs both mobile numbers and NID with Own while keeping address and operating system full width', async () => {
    fetchMock.mockResolvedValue(json({
      ...result,
      fields: [
        { label: 'connection_address', value: 'Dhaka', section: 'Connection details' },
        { label: 'operating_system', value: 'Windows 11', section: 'Connection details' },
        { label: 'Alternative mobile', value: '০১৭১২৩৪৫৬৭৮', section: 'Connection details' },
        { label: 'Own', value: 'Checked', section: 'Connection details' },
        { label: 'Color', value: 'Red   ', section: 'Connection details' },
        { label: 'NID number', value: '00123456789', section: 'Connection details' },
        { label: 'Mobile number', value: '০১৮১২৩৪৫৬৭৮', section: 'Connection details' },
      ],
    }));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    const address = await screen.findByRole('textbox', { name: 'connection_address' });
    const operatingSystem = screen.getByRole('textbox', { name: 'operating_system' });
    expect(address.closest('.field')).toHaveClass('field-single-column');
    expect(operatingSystem.closest('.field')).toHaveClass('field-single-column');
    const mobileField = screen.getByRole('textbox', { name: 'Mobile number' }).closest('.field');
    const alternativeField = screen.getByRole('textbox', { name: 'Alternative mobile' }).closest('.field');
    const nidField = screen.getByRole('textbox', { name: 'NID number' }).closest('.field');
    const ownField = screen.getByRole('textbox', { name: 'Own' }).closest('.field');
    expect(mobileField).toHaveClass('field-pair-left');
    expect(alternativeField).toHaveClass('field-pair-right');
    expect(mobileField?.nextElementSibling).toBe(alternativeField);
    expect(nidField).toHaveClass('field-pair-left');
    expect(ownField).toHaveClass('field-pair-right');
    expect(nidField?.nextElementSibling).toBe(ownField);
    expect(screen.getByRole('textbox', { name: 'NID number' })).toHaveValue('00123456789');
    expect(screen.getByRole('textbox', { name: 'Mobile number' })).toHaveValue('০১৮১২৩৪৫৬৭৮');
    expect(screen.getByRole('textbox', { name: 'Alternative mobile' })).toHaveValue('০১৭১২৩৪৫৬৭৮');
    expect(screen.getByRole('textbox', { name: 'Own' })).toHaveValue('Own');
    expect(screen.getByRole('textbox', { name: 'Color' })).toHaveValue('Red');
    await user.clear(operatingSystem);
    await user.type(operatingSystem, 'Linux');
    expect(operatingSystem.closest('.field')).toHaveClass('field-single-column');
    await user.click(screen.getByRole('button', { name: 'Copy operating_system value' }));
    expect(writeText).toHaveBeenLastCalledWith('Linux');
    await user.click(screen.getByRole('button', { name: 'Copy Alternative mobile value' }));
    expect(writeText).toHaveBeenLastCalledWith('০১৭১২৩৪৫৬৭৮');
    await user.click(screen.getByRole('button', { name: 'Copy Own value' }));
    expect(writeText).toHaveBeenLastCalledWith('Own');
    await user.click(screen.getByRole('button', { name: 'Copy Color value' }));
    expect(writeText).toHaveBeenLastCalledWith('Red');
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.messages[0].content).toContain('Read BOTH columns of every row');
    expect(payload.messages[0].content).toContain('return TWO separate fields');
    expect(payload.messages[0].content).toContain('still return both labeled fields');
  });

  it('displays multiline extracted values in editable textareas', async () => {
    fetchMock.mockResolvedValue(json({ ...result, fields: [{ id: 'field-1', label: 'Address', value: '123 Maple Lane\nPortland', section: 'Address' }] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('123 Maple Lane\nPortland'));
    expect(screen.getByRole('textbox', { name: 'Address' }).tagName).toBe('TEXTAREA');
  });

  it('requests actual selected option text and displays checkbox answers instead of generic checked states', async () => {
    fetchMock.mockResolvedValue(json({
      ...result,
      fields: [
        { label: 'Marital status', value: 'Married', section: 'Personal information' },
        { label: 'লিঙ্গ', value: 'নারী', section: 'ব্যক্তিগত তথ্য' },
        { label: 'Languages', value: 'বাংলা\nEnglish', section: 'Preferences' },
        { label: 'Receive updates', value: 'No', section: 'Preferences' },
        { label: 'Own', value: 'Checked', section: 'Connection details' },
      ],
      rawText: 'Marital status: [ ] Single [x] Married\nলিঙ্গ: [ ] পুরুষ [x] নারী\nLanguages: [x] বাংলা [x] English\nReceive updates: [ ] Yes [x] No\n[x] Own',
    }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByRole('textbox', { name: 'Marital status' })).toHaveValue('Married');
    expect(screen.getByRole('textbox', { name: 'লিঙ্গ' })).toHaveValue('নারী');
    expect(screen.getByRole('textbox', { name: 'Languages' })).toHaveValue('বাংলা\nEnglish');
    expect(screen.getByRole('textbox', { name: 'Receive updates' })).toHaveValue('No');
    expect(screen.getByRole('textbox', { name: 'Own' })).toHaveValue('Own');
    expect(screen.queryByDisplayValue('Checked')).not.toBeInTheDocument();
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.messages[0].content).toContain('use the actual visible text of the selected option as the value');
    expect(payload.messages[0].content).toContain('never substitute "Checked"');
  });

  it('renders Bengali fields dynamically and omits blank fields and their sections', async () => {
    const bengali = {
      ...result,
      fields: [
        { id: 'name', label: 'নাম', value: 'তানিয়া আক্তার', section: 'ব্যক্তিগত তথ্য' },
        { id: 'mobile', label: 'মোবাইল নম্বর', value: '০১৭১২৩৪৫৬৭৮', section: 'যোগাযোগ' },
        { id: 'count', label: 'সংখ্যা', value: '০', section: 'ব্যক্তিগত তথ্য' },
        { id: 'empty', label: 'খালি ঘর', value: '', section: 'খালি বিভাগ' },
        { id: 'whitespace', label: 'Email', value: '\t\n ', section: 'Empty section' },
      ],
      rawText: 'নাম: তানিয়া আক্তার\nমোবাইল নম্বর: ০১৭১২৩৪৫৬৭৮\nখালি ঘর:',
    };
    fetchMock.mockResolvedValue(json(bengali));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByRole('textbox', { name: 'নাম' })).toHaveValue('তানিয়া আক্তার');
    expect(screen.getByRole('textbox', { name: 'মোবাইল নম্বর' })).toHaveValue('০১৭১২৩৪৫৬৭৮');
    expect(screen.getByRole('textbox', { name: 'সংখ্যা' })).toHaveValue('০');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByRole('textbox', { name: 'খালি ঘর' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'খালি বিভাগ' })).not.toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'নাম' });
    await user.clear(name);
    expect(screen.getByRole('textbox', { name: 'নাম' })).toBe(name);
    await user.type(name, 'সংশোধিত নাম');
    expect(name).toHaveValue('সংশোধিত নাম');
    await user.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByText(/খালি ঘর:/)).toBeInTheDocument();
  });

  it('keeps grouped address values under their label and omits an empty father name', async () => {
    fetchMock.mockResolvedValue(json({
      ...result,
      fields: [
        { label: "Father's name", value: '', section: 'Personal information' },
        { label: 'connection_address', value: '১২৩ প্রধান সড়ক\nঢাকা\n১২১৬', section: 'Connection details' },
      ],
      rawText: "Father's name:\nconnection_address:\n১২৩ প্রধান সড়ক\nঢাকা\n১২১৬",
    }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByRole('textbox', { name: 'connection_address' })).toHaveValue('১২৩ প্রধান সড়ক\nঢাকা\n১২১৬');
    expect(screen.queryByRole('textbox', { name: "Father's name" })).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.messages[0].content).toContain('Never move, copy, or borrow a value from a neighboring field');
    expect(payload.messages[0].content).toContain('regardless of which address box appears above that label');
    await user.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByText(/Father's name:/)).toBeInTheDocument();
  });

  it('shows a useful zero-field state while preserving the original transcription', async () => {
    fetchMock.mockResolvedValue(json({ ...result, fields: [], rawText: 'নাম:\nঠিকানা:', warnings: ['No populated fields.'] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByText('No filled fields were found.')).toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'View raw text' }));
    expect(screen.getByText(/নাম:/)).toHaveTextContent('ঠিকানা:');
  });

  it('keeps duplicate labels independently editable, even after clearing a value', async () => {
    fetchMock.mockResolvedValue(json({ ...result, fields: [
      { id: 'duplicate', label: 'Name', value: 'First Person', section: 'People' },
      { id: 'duplicate', label: 'Name', value: 'Second Person', section: 'People' },
    ] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    const names = await screen.findAllByRole('textbox', { name: 'Name' });
    await user.clear(names[1]);
    expect(screen.getAllByRole('textbox', { name: 'Name' })[1]).toBe(names[1]);
    expect(names[0]).toHaveValue('First Person');
    await user.type(names[1], 'Edited Second');
    expect(names[1]).toHaveValue('Edited Second');
    expect(screen.queryByText('No filled fields were found.')).not.toBeInTheDocument();
  });

  it('replaces the previous dynamic form completely when extracting again', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => json(++calls === 1 ? result : { ...result, fields: [{ id: 'invoice', label: 'Invoice total', value: '৳১০০', section: '' }] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    await screen.findByRole('textbox', { name: 'Applicant name' });
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    expect(await screen.findByRole('textbox', { name: 'Invoice total' })).toHaveValue('৳১০০');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: 'Applicant name' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
  });

  it('unmounting aborts extraction and prevents stale results from appearing after remount', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
    const user = userEvent.setup();
    const app = render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract information' }));
    app.unmount();
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    render(<App />);
    await act(async () => { resolve(json(result)); });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Extract information' })).toBeDisabled();
  });
});
