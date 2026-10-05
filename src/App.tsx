import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import {
  ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight,
  CircleHelp, Clipboard, FileImage, FileText, Focus, ImagePlus, LayoutDashboard,
  LoaderCircle, PanelLeftClose, RotateCcw, ScanLine,
  Sparkles, Upload, UserRound, X,
} from 'lucide-react';
import { extractForm } from './lib/groq';
import type { ExtractedField, ExtractionResult, FormImage } from './types';

const MAX_FILE_SIZE = 8 * 1024 * 1024;

const DEMO_RESULT: ExtractionResult = {
  fields: [
    { id: 'full-name', label: 'Full name', value: 'Alex Morgan', section: 'Personal information' },
    { id: 'date-of-birth', label: 'Date of birth', value: 'June 15, 1994', section: 'Personal information' },
    { id: 'occupation', label: 'Occupation', value: 'Graphic designer', section: 'Personal information' },
    { id: 'email', label: 'Email address', value: 'alex.morgan@example.com', section: 'Contact details' },
    { id: 'phone', label: 'Phone number', value: '(202) 555-0147', section: 'Contact details' },
    { id: 'street', label: 'Street address', value: '123 Maple Lane', section: 'Address' },
    { id: 'city', label: 'City', value: 'Portland', section: 'Address' },
    { id: 'state', label: 'State / Province', value: 'Oregon', section: 'Address' },
    { id: 'postal', label: 'ZIP / Postal code', value: '97205', section: 'Address' },
  ],
  rawText: 'GREENFIELD COMMUNITY\nMember registration\nPlease complete all fields below. This is a fictional sample form.\n\n01 PERSONAL INFORMATION\nFull name: Alex Morgan\nDate of birth: June 15, 1994\nOccupation: Graphic designer\n\n02 CONTACT DETAILS\nEmail address: alex.morgan@example.com\nPhone number: (202) 555-0147\n\n03 MAILING ADDRESS\nStreet address: 123 Maple Lane\nCity: Portland\nState: Oregon\nZIP code: 97205\n\nFICTIONAL DEMO · No real personal information · FormLens',
  warnings: [],
  model: 'Local demo',
};

function prepareFields(incoming: ExtractedField[]): ExtractedField[] {
  const filled = incoming.filter((field) => field.value.trim());
  const idCounts = new Map<string, number>();
  filled.forEach((field) => idCounts.set(field.id, (idCounts.get(field.id) ?? 0) + 1));
  const safeId = (id: string) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
  const usedIds = new Set(filled.filter((field) => safeId(field.id) && idCounts.get(field.id) === 1).map((field) => field.id));
  return filled.map((field, index) => {
    let id = field.id;
    if (!safeId(id) || idCounts.get(id) !== 1) {
      id = `field-${index}`;
      while (usedIds.has(id)) id += '-local';
      usedIds.add(id);
    }
    return { ...field, id, section: field.section?.trim() ? field.section : 'General' };
  });
}

function validResult(value: unknown): value is ExtractionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ExtractionResult;
  return Array.isArray(result.fields) && result.fields.every((field) => field && typeof field.label === 'string' && typeof field.value === 'string'
    && (field.id === undefined || typeof field.id === 'string') && (field.section === undefined || typeof field.section === 'string'))
    && typeof result.rawText === 'string' && typeof result.model === 'string'
    && Array.isArray(result.warnings) && result.warnings.every((warning) => typeof warning === 'string');
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('This image could not be read. Please try another file.'));
    reader.onload = () => {
      const url = String(reader.result);
      const image = new Image();
      image.onload = () => resolve(url);
      image.onerror = () => reject(new Error('This file does not appear to be a valid image. Try a JPG, PNG, or WebP.'));
      image.src = url;
    };
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isSingleColumnField(label: string) {
  return ['connection_address', 'operating_system'].includes(fieldLabelKey(label));
}

function fieldLabelKey(label: string) {
  return label.trim().toLowerCase().replace(/[.:]+$/g, '').replace(/[\s-]+/g, '_');
}

type PairedFieldRole = 'nid' | 'own' | 'mobile' | 'alternative-mobile';

function pairedFieldRole(label: string): PairedFieldRole | undefined {
  const key = fieldLabelKey(label);
  if (/^(nid(?:_(number|no))?|national_id(?:_number)?|এনআইডি(?:_নম্বর)?)$/.test(key)) return 'nid';
  if (key === 'own') return 'own';
  if (/^(mobile(?:_(number|no))?|মোবাইল(?:_নম্বর)?)$/.test(key)) return 'mobile';
  if (/^((alternative|alternate|secondary|alt)_mobile(?:_(number|no))?|বিকল্প_মোবাইল(?:_নম্বর)?)$/.test(key)) return 'alternative-mobile';
}

/** Pair related fields for display without changing their values, IDs, or sections. */
function layoutFields(sectionFields: ExtractedField[]) {
  const positioned: { field: ExtractedField; column?: 'left' | 'right' }[] = [];
  const used = new Set<ExtractedField>();
  const pairs: [PairedFieldRole, PairedFieldRole][] = [['nid', 'own'], ['mobile', 'alternative-mobile']];
  for (const field of sectionFields) {
    if (used.has(field)) continue;
    const role = pairedFieldRole(field.label);
    const pair = pairs.find((roles) => role !== undefined && roles.includes(role));
    const left = pair ? sectionFields.filter((item) => pairedFieldRole(item.label) === pair[0]) : [];
    const right = pair ? sectionFields.filter((item) => pairedFieldRole(item.label) === pair[1]) : [];
    if (left.length === 1 && right.length === 1) {
      positioned.push({ field: left[0], column: 'left' }, { field: right[0], column: 'right' });
      used.add(left[0]);
      used.add(right[0]);
    } else {
      positioned.push({ field });
      used.add(field);
    }
  }
  return positioned;
}

export default function App() {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY?.trim() ?? '';
  const [image, setImage] = useState<FormImage | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [fields, setFields] = useState<ExtractedField[]>([]);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'fields' | 'raw'>('fields');
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const versionRef = useRef(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demo = image?.source === 'demo';
  const fieldCount = fields.length;

  useEffect(() => () => {
    versionRef.current += 1;
    requestRef.current?.abort();
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  function resetResults() {
    setResult(null);
    setFields([]);
    setTab('fields');
    setDownloadOpen(false);
    setFeedback('');
  }

  function invalidateRequest() {
    versionRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    setReading(false);
    setError('');
    return versionRef.current;
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPG, PNG, or WebP image. Other file types are not supported.');
      return;
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
      setError(file.size === 0 ? 'This file is empty. Please choose another image.' : 'This image is too large. Please choose a file under 8 MB.');
      return;
    }
    const version = invalidateRequest();
    resetResults();
    setImage(null);
    setReading(true);
    try {
      const url = await readImage(file);
      if (version !== versionRef.current) return;
      setImage({ url, name: file.name, size: file.size, source: 'upload' });
    } catch (err) {
      if (version === versionRef.current) setError(err instanceof Error ? err.message : 'Unable to open this image.');
    } finally {
      if (version === versionRef.current) setReading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void chooseFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function loadDemo() {
    invalidateRequest();
    setImage({ url: '/demo-form.svg', name: 'Sample registration form', size: 0, source: 'demo' });
    setResult(DEMO_RESULT);
    setFields(prepareFields(DEMO_RESULT.fields));
    setTab('fields');
    setDownloadOpen(false);
    setFeedback('');
  }

  function removeImage() {
    invalidateRequest();
    setImage(null);
    resetResults();
  }

  async function extract() {
    if (!image || image.source === 'demo' || !apiKey.trim() || loading || reading) return;
    const version = invalidateRequest();
    const controller = new AbortController();
    requestRef.current = controller;
    resetResults();
    setLoading(true);
    try {
      const data = await extractForm({ image: image.url, apiKey: apiKey.trim(), signal: controller.signal });
      if (!validResult(data)) throw new Error('Groq returned an unexpected result. Please try again.');
      if (version !== versionRef.current || controller.signal.aborted) return;
      setResult(data);
      setFields(prepareFields(data.fields));
    } catch (err) {
      if (version === versionRef.current && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Unable to connect. Please check your connection and try again.');
      }
    } finally {
      if (version === versionRef.current) { setLoading(false); requestRef.current = null; }
    }
  }

  function notify(message: string) {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(message);
    feedbackTimer.current = setTimeout(() => setFeedback(''), 3500);
  }

  async function copyFieldValue(field: ExtractedField) {
    if (!result || loading || !field.value.trim()) return;
    const version = versionRef.current;
    try {
      await navigator.clipboard.writeText(field.value.trimEnd());
      if (version === versionRef.current) notify(`${field.label} copied`);
    } catch {
      if (version === versionRef.current) notify('Copy unavailable. Select the field value to copy it manually.');
    }
  }

  async function copyRawText() {
    if (!result) return;
    const version = versionRef.current;
    try {
      await navigator.clipboard.writeText(result.rawText);
      if (version === versionRef.current) notify('Copied to clipboard');
    } catch {
      if (version === versionRef.current) notify('Copy unavailable. Use Download instead.');
    }
  }

  function download(format: 'json' | 'csv') {
    if (!result) return;
    const csvCell = (value: string) => {
      const safe = /^\s*[=+@-]/.test(value) ? `'${value}` : value;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const content = format === 'json'
      ? JSON.stringify({ ...result, fields, mode: demo ? 'demo' : 'extracted' }, null, 2)
      : ['Section,Field,Value', ...fields.map((field) => [field.section, field.label, field.value].map(csvCell).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `formlens-${demo ? 'demo' : 'results'}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloadOpen(false);
    notify(`${format.toUpperCase()} download started`);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) { setError('Please upload one form image at a time.'); return; }
    void chooseFile(event.dataTransfer.files[0]);
  }

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'fields' : event.key === 'End' ? 'raw' : tab === 'fields' ? 'raw' : 'fields';
    setTab(next);
    document.getElementById(`${next}-tab`)?.focus();
  }

  const sections = [...new Set(fields.map((field) => field.section))];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#main"><span className="brand-mark"><Focus size={23} strokeWidth={2.1} /></span>Form<span className="brand-light">Lens</span><span className="brand-dot">.</span></a>
        <div className="sidebar-label">YOUR WORKSPACE</div>
        <nav className="side-nav">
          <button className={!showGuide ? 'nav-item active' : 'nav-item'} onClick={() => setShowGuide(false)}><ScanLine size={19} />Extract a form<ChevronRight size={15} className="nav-chevron" /></button>
          <button className={showGuide ? 'nav-item active' : 'nav-item'} onClick={() => setShowGuide(!showGuide)} aria-expanded={showGuide}><CircleHelp size={19} />How it works</button>
        </nav>
        <div className="sidebar-note"><div className="note-art"><FileText size={27} /><Sparkles size={17} /></div><h3>Less paperwork.<br />More possibilities.</h3><p>Turn the little details into something you can work with.</p><button onClick={loadDemo}>Explore a demo <ArrowRight size={14} /></button></div>
        <div className="sidebar-bottom"><span className="privacy-token"><FileImage size={17} /></span><div><strong>You choose when to send</strong><span>Upload first. Extract when ready.</span></div></div>
      </aside>

      <div className="workspace">
        <header className="topbar"><div className="breadcrumb"><LayoutDashboard size={16} /><span>Workspace</span><ChevronRight size={13} /><strong>Form extraction</strong></div><div className="topbar-right"><span className="local-tag"><span />Your browser workspace</span><span className="avatar" aria-label="FormLens workspace">FL</span></div></header>
        <main id="main" className="main-content">
          <section className="page-heading"><div><div className="eyebrow"><span /> A LITTLE AI. A LOT LESS TYPING.</div><h1>Your forms. Now in focus<span>.</span></h1><p>From a photo to organized information, in just a few clicks.</p></div><button className="button demo-button" onClick={loadDemo}><Sparkles size={16} />Try a demo<ArrowRight size={15} /></button></section>

          {showGuide && <section className="guide-panel" aria-label="How it works"><div><span className="step-mini">1</span><strong>Upload your form</strong><p>Use a clear, well-lit JPG, PNG, or WebP image. Uploading creates a local preview.</p></div><div><span className="step-mini">2</span><strong>Extract with AI</strong><p>The Groq API key is already configured. Choose Extract to send the base64 image directly from your browser to Groq.</p></div><div><span className="step-mini">3</span><strong>Make it yours</strong><p>Review the details, edit any field, then copy or download.</p></div><button className="icon-button" aria-label="Close guide" onClick={() => setShowGuide(false)}><X size={17} /></button></section>}

          <div className="workflow-bar"><div className="workflow-step current"><span>01</span>Upload a form</div><div className="workflow-line" /><div className={`workflow-step ${result ? 'current' : ''}`}><span>02</span>Review & refine</div><div className="workflow-line" /><div className={`workflow-step ${result ? 'ready' : ''}`}><span>03</span>Make it useful</div><span className="workflow-caption">Simple by design.</span></div>

          <div className="editor-grid">
            <section className="card image-card" aria-labelledby="upload-title">
              <div className="card-header"><div className="card-title"><span className="icon-token mint"><FileImage size={19} /></span><div><h2 id="upload-title">Your document</h2><p>A good image makes all the difference.</p></div></div><span className={`status-pill ${image ? 'ready-pill' : ''}`}>{demo ? 'Demo' : image ? 'Ready' : 'Step 01'}</span></div>
              <div className="image-card-body">
                <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFileChange} className="visually-hidden" tabIndex={-1} aria-label="Upload a form image" />
                <div className={`preview-area ${image ? 'has-image' : ''} ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={handleDrop}>
                  {image ? <><div className="preview-label"><span className="preview-dot" />{demo ? 'FICTIONAL SAMPLE' : 'IMAGE PREVIEW'}</div><img className="document-image" src={image.url} alt={demo ? 'Fictional filled registration form for Alex Morgan' : 'Uploaded form to extract'} /><span className="preview-corner corner-tl" /><span className="preview-corner corner-tr" /><span className="preview-corner corner-bl" /><span className="preview-corner corner-br" /></> : reading ? <div className="upload-empty" role="status"><LoaderCircle size={34} className="spin" /><h3>Opening your image…</h3><p>Getting everything into focus.</p></div> : <div className="upload-empty"><div className="empty-illustration" aria-hidden="true"><div className="mini-sheet sheet-back" /><div className="mini-sheet sheet-front"><span className="mini-heading" /><span className="mini-line" /><div className="mini-field" /><div className="mini-field short" /><div className="mini-field" /></div><span className="illustration-badge"><ScanLine size={25} /></span><span className="little-spark spark-one">✦</span><span className="little-spark spark-two">✦</span></div><h3>A form, a photo, a fresh start.</h3><p>Drag & drop your image here<br />or choose one from your device.</p><button className="button upload-button" onClick={() => inputRef.current?.click()}><Upload size={16} />Choose an image</button><span className="file-hint">JPG, PNG or WebP <span>·</span> Up to 8 MB</span></div>}
                  {dragging && <div className="drop-overlay"><ImagePlus size={33} /><strong>Drop your form here</strong></div>}
                </div>

                {image && <div className="file-row"><span className="file-icon"><FileImage size={18} /></span><div className="file-details"><strong title={image.name}>{image.name}</strong><span>{demo ? 'Local sample · No upload required' : `${formatSize(image.size)} · Image ready to extract`}</span></div><button className="icon-button" onClick={() => inputRef.current?.click()} aria-label="Replace image" title="Replace image"><RotateCcw size={16} /></button><button className="icon-button" onClick={removeImage} aria-label="Remove image" title="Remove image"><X size={17} /></button></div>}
                {!image && !reading && <div className="sample-prompt"><span>Just looking around?</span><button onClick={loadDemo}>Try our sample form <ArrowRight size={13} /></button></div>}
                {error && <div className="notice error-notice" role="alert"><CircleHelp size={17} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
                {demo ? <div className="demo-notice"><Sparkles size={16} /><span><strong>You're exploring the demo.</strong> These fictional results are prepared locally. No API key is needed. Upload your own image to extract a real form.</span></div> : <button className="button extract-button" onClick={() => void extract()} disabled={!image || !apiKey.trim() || loading || reading}>{loading ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}{loading ? 'Reading your form…' : 'Extract information'}{!loading && <ArrowRight size={17} />}</button>}
                <p className="privacy-note"><FileImage size={14} /><span>Your base64 image goes directly from your browser to Groq only when you click Extract. Review AI results before using them.</span></p>
              </div>
            </section>

            <section className="card results-card" aria-labelledby="results-title" aria-busy={loading}>
              <div className="card-header"><div className="card-title"><span className="icon-token peach"><FileText size={19} /></span><div><h2 id="results-title">The little details</h2><p>{result ? 'All in one place. Ready for your finishing touch.' : 'Organized, editable, and ready when you are.'}</p></div></div><span className={`status-pill ${result ? 'ready-pill' : ''}`}>{demo ? 'Demo results' : result ? `${fieldCount} fields` : 'Step 02'}</span></div>
              <div className="result-tabs" role="tablist" aria-label="Result format" onKeyDown={navigateTabs}>
                <button id="fields-tab" role="tab" tabIndex={tab === 'fields' ? 0 : -1} aria-selected={tab === 'fields'} aria-controls="fields-panel" className={tab === 'fields' ? 'selected' : ''} onClick={() => setTab('fields')}>
                  <LayoutDashboard size={15} />Form fields{result && <span className="count-chip">{fieldCount}</span>}
                </button>
                <button id="raw-tab" role="tab" tabIndex={tab === 'raw' ? 0 : -1} aria-selected={tab === 'raw'} aria-controls="raw-panel" className={tab === 'raw' ? 'selected' : ''} onClick={() => setTab('raw')}>
                  <FileText size={15} />Raw text
                </button>
                {result && <span className="edit-hint"><CheckCheck size={14} />Ready to review</span>}
              </div>
              <div className="results-body">
                {tab === 'fields' ? (
                  <div id="fields-panel" role="tabpanel" aria-labelledby="fields-tab" className="fields-panel">
                    {fieldCount === 0 && <div className={`fields-placeholder ${loading ? 'is-loading' : ''}`} role="status">
                      <span className="fields-placeholder-icon">{loading ? <LoaderCircle size={28} className="spin" /> : result ? <FileText size={28} /> : <ScanLine size={28} />}</span>
                      <h3>{loading ? 'Finding the details that matter…' : result ? 'No filled fields were found.' : 'Your form sets the shape.'}</h3>
                      <p>{loading ? 'AI is reading your image. Its fields will appear here after extraction.' : result ? 'Check the Raw text tab for any readable text, or try a clearer photo of the filled form.' : 'Upload and extract a form to see its original labels and filled values here, ready to review and edit.'}</p>
                      {result && <button className="button copy-button" onClick={() => setTab('raw')}><FileText size={14} />View raw text<ArrowRight size={14} /></button>}
                      {!result && !loading && <span className="fields-placeholder-note">Every form is different. Your results will be, too.</span>}
                    </div>}
                    {sections.map((section) => (
                      <div className="field-section" key={section}>
                        <h3>
                          <span className="section-icon"><FileText size={15} /></span>
                          <span className="section-label">{section}</span><span className="section-rule" />
                        </h3>
                        <div className="field-grid">
                          {layoutFields(fields.filter((field) => field.section === section)).map(({ field, column }) => (
                            <div key={field.id} className={`field ${!column && (field.value.includes('\n') || field.value.length > 80) ? 'field-wide' : ''} ${isSingleColumnField(field.label) ? 'field-single-column' : ''} ${column ? `field-pair-${column}` : ''}`}>
                              <div className="field-header">
                                <label htmlFor={`field-input-${field.id}`}>{field.label}{result && field.value.trim() && <Check size={11} className="field-check" />}</label>
                                <button className="icon-button field-copy-button" type="button" aria-label={`Copy ${field.label} value`} title="Copy value" disabled={!result || loading || !field.value.trim()} onClick={() => void copyFieldValue(field)}><Clipboard size={13} /></button>
                              </div>
                              <textarea
                                id={`field-input-${field.id}`}
                                value={field.value} disabled={!result || loading} rows={field.value.includes('\n') || field.value.length > 80 ? 3 : 1}
                                onChange={(event) => setFields((previous) => previous.map((item) => item.id === field.id ? { ...item, value: event.target.value } : item))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div id="raw-panel" role="tabpanel" aria-labelledby="raw-tab" className="raw-panel">
                    {result ? <><div className="raw-heading">ORIGINAL EXTRACTED TEXT<span>Field edits don't change this text</span></div><pre>{result.rawText || 'No readable text was found in this image.'}</pre></> : <div className="raw-empty"><FileText size={31} /><h3>The original, in plain text.</h3><p>The text from your form will appear here after extraction.</p></div>}
                  </div>
                )}
              </div>
              {result && result.warnings.length > 0 && <div className="result-warnings" role="status"><CircleHelp size={16} /><div><strong>A few things to double-check</strong><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></div>}
              <div className="results-footer"><span className="footer-note">{result ? <><CheckCheck size={15} />Review & edit before exporting</> : <><PanelLeftClose size={15} />Your results will appear here</>}</span><div className="export-actions">{tab === 'raw' && <button className="button copy-button" disabled={!result} onClick={() => void copyRawText()}><Clipboard size={14} />Copy raw text</button>}<div className="download-wrapper"><button className="button download-button" disabled={!result} onClick={() => setDownloadOpen(!downloadOpen)} aria-expanded={downloadOpen} aria-controls="download-options"><ArrowDownToLine size={15} />Download<ChevronDown size={12} /></button>{downloadOpen && <div id="download-options" className="download-menu" onKeyDown={(event) => { if (event.key === 'Escape') setDownloadOpen(false); }}><button onClick={() => download('json')}><FileText size={15} /><span>Download JSON<small>Structured, edited fields</small></span></button><button onClick={() => download('csv')}><LayoutDashboard size={15} /><span>Download CSV<small>Ready for your spreadsheet</small></span></button></div>}</div></div></div>
              <div className="copy-feedback" role="status" aria-live="polite">{feedback && <><Check size={14} />{feedback}</>}</div>
            </section>
          </div>

          <section className="bottom-features" aria-label="Benefits"><div><span className="feature-icon"><ScanLine size={18} /></span><span><strong>From pixels to possibilities</strong><small>Printed or handwritten. Let AI do the reading.</small></span></div><div><span className="feature-icon"><UserRound size={18} /></span><span><strong>You're in the driver's seat</strong><small>Every field is yours to review and refine.</small></span></div><div><span className="feature-icon"><ArrowDownToLine size={18} /></span><span><strong>Ready for your next step</strong><small>Copy the details or export JSON and CSV.</small></span></div></section>
          <footer className="page-footer"><span>Made for the details. Designed for you.</span><span><Focus size={12} />FORMLENS</span></footer>
        </main>
      </div>
    </div>
  );
}
