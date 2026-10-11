import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { img2txt } = vi.hoisted(() => ({ img2txt: vi.fn() }));

import App from './App';

const result = {
  fields: [
    { label: 'Applicant name', value: 'Sam Rivera', section: 'Applicant' },
    { label: 'Email', value: 'sam@example.com', section: 'Contact' },
    { label: 'Membership number', value: '00142', section: 'Membership' },
  ],
  rawText: 'Applicant name: Sam Rivera\nEmail: sam@example.com\nMembership number: 00142',
  warnings: ['Review handwriting.'],
};
const PNG_BYTES = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0));

beforeEach(() => {
  img2txt.mockReset();
  img2txt.mockResolvedValue(JSON.stringify(result));
  vi.stubGlobal('puter', { ai: { img2txt } });
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  });
});

afterEach(() => vi.unstubAllGlobals());

async function upload(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Upload a form image'), new File([PNG_BYTES], 'registration.png', { type: 'image/png' }));
  await screen.findByAltText('Uploaded form to extract');
}

describe('FormLens user flow with Puter OCR', () => {
  it('starts with no predefined fields and no Puter call', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Extract with Puter' })).toBeDisabled();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(img2txt).not.toHaveBeenCalled();
  });

  it('demo is local and does not contact Puter', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try a demo' }));
    expect(screen.getByText("You're exploring the demo.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Alex Morgan');
    expect(img2txt).not.toHaveBeenCalled();
  });

  it('sends a base64 data URI to Puter and renders only dynamic returned fields', async () => {
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Applicant name' })).toHaveValue('Sam Rivera'));
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByRole('textbox', { name: 'Full name' })).not.toBeInTheDocument();
    expect(screen.getByText('Review handwriting.')).toBeInTheDocument();
    expect(img2txt).toHaveBeenCalledTimes(1);
    const [image, options] = img2txt.mock.calls[0];
    expect(image).toMatch(/^data:image\/png;base64,/);
    expect(options.model).toBe('mistral-ocr-latest');
    expect(options.provider).toBe('mistral');
  });

  it('renders Bengali values, explicit zero, and omits blank fields', async () => {
    img2txt.mockResolvedValue(JSON.stringify({
      fields: [
        { label: 'নাম', value: 'তানিয়া আক্তার', section: 'ব্যক্তিগত তথ্য' },
        { label: 'মোবাইল নম্বর', value: '০১৭১২৩৪৫৬৭৮', section: 'যোগাযোগ' },
        { label: 'সংখ্যা', value: '০', section: 'ব্যক্তিগত তথ্য' },
        { label: 'খালি ঘর', value: '', section: 'খালি বিভাগ' },
      ], rawText: 'নাম: তানিয়া আক্তার\nখালি ঘর:', warnings: [],
    }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    expect(await screen.findByRole('textbox', { name: 'নাম' })).toHaveValue('তানিয়া আক্তার');
    expect(screen.getByRole('textbox', { name: 'মোবাইল নম্বর' })).toHaveValue('০১৭১২৩৪৫৬৭৮');
    expect(screen.getByRole('textbox', { name: 'সংখ্যা' })).toHaveValue('০');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByRole('textbox', { name: 'খালি ঘর' })).not.toBeInTheDocument();
  });

  it('keeps multiline values editable and preserves raw text', async () => {
    img2txt.mockResolvedValue(JSON.stringify({ ...result, fields: [{ label: 'Address', value: 'ঢাকা\nবাংলাদেশ', section: 'ঠিকানা' }], rawText: 'Address:\nঢাকা\nবাংলাদেশ', warnings: [] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    const address = await screen.findByRole('textbox', { name: 'Address' });
    expect(address.tagName).toBe('TEXTAREA');
    await user.clear(address);
    await user.type(address, 'চট্টগ্রাম');
    expect(address).toHaveValue('চট্টগ্রাম');
    await user.click(screen.getByRole('tab', { name: 'Raw text' }));
    expect(screen.getByText(/ঢাকা/)).toBeInTheDocument();
  });

  it('shows a zero-field state while retaining raw text', async () => {
    img2txt.mockResolvedValue(JSON.stringify({ fields: [], rawText: 'নাম:\nঠিকানা:', warnings: ['No populated fields.'] }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    expect(await screen.findByText('No filled fields were found.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View raw text' }));
    expect(screen.getByText(/নাম:/)).toHaveTextContent('ঠিকানা:');
  });

  it('shows a safe Puter error without fabricated fields', async () => {
    img2txt.mockRejectedValue(Object.assign(new Error('private payload'), { code: 'insufficient_funds' }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota or funds');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('aborts stale Puter results after removing the image', async () => {
    let resolve!: (value: string) => void;
    img2txt.mockImplementation(() => new Promise<string>((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<App />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Extract with Puter' }));
    await user.click(screen.getByRole('button', { name: 'Remove image' }));
    await act(async () => { resolve(JSON.stringify(result)); });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
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
    expect(img2txt).not.toHaveBeenCalled();
  });
});
