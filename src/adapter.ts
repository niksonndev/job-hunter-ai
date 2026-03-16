export interface AdaptedResume {
  content: string;
}

export function adaptResume(baseResume: string, context: { jobTitle: string; jobDescription: string }): AdaptedResume {
  return {
    content: baseResume,
  };
}
