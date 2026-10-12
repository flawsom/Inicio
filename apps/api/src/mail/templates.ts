export interface RenderedMail {
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

function layout(heading: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
  <h1 style="font-size:20px">${heading}</h1>
  ${body}
  <p style="color:#555;font-size:12px">Inicio School Ranking Survey 2026</p>
  </body></html>`;
}

export function otpEmail(to: string, code: string): RenderedMail {
  return {
    template: 'otp',
    to,
    subject: `Your Inicio survey login code: ${code}`,
    html: layout(
      'Your login code',
      `<p>Enter this code to continue. It expires in ${'10'} minutes.</p>
       <p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p>
       <p>If you did not request this, you can ignore this email.</p>`,
    ),
    text: `Your Inicio survey login code is ${code}. It expires shortly.`,
  };
}

export function otpVerifiedEmail(to: string): RenderedMail {
  return {
    template: 'otp_verified',
    to,
    subject: 'Inicio survey: login confirmed',
    html: layout('You are logged in', '<p>A sign-in to your Inicio survey account just completed.</p>'),
    text: 'A sign-in to your Inicio survey account just completed.',
  };
}

export function submissionConfirmationEmail(to: string, uniqueId: string, at: string): RenderedMail {
  return {
    template: 'submission_confirmation',
    to,
    subject: 'Inicio survey: submission received',
    html: layout(
      'Submission received',
      `<p>Your questionnaire was submitted and is now read-only.</p>
       <p><strong>Submission ID:</strong> ${uniqueId}<br/><strong>Submitted at:</strong> ${at}</p>`,
    ),
    text: `Your questionnaire was submitted.\nSubmission ID: ${uniqueId}\nSubmitted at: ${at}`,
  };
}
