export interface JobData {
  title: string;
  description: string;
  url: string;
}

export async function scrapeJob(url: string): Promise<JobData> {
  return {
    title: '',
    description: '',
    url,
  };
}
