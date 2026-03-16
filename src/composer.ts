export interface EmailContent {
  subject: string;
  body: string;
}

export function composeEmail(options: {
  jobTitle: string;
  company?: string;
  adaptedResume: string;
}): EmailContent {
  return {
    subject: '',
    body: '',
  };
}
