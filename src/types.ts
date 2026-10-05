export interface ExtractedField {
  id: string;
  label: string;
  value: string;
  section: string;
}

export interface ExtractionResult {
  fields: ExtractedField[];
  rawText: string;
  warnings: string[];
  model: string;
}

export interface FormImage {
  url: string;
  name: string;
  size: number;
  source: 'upload' | 'demo';
}
