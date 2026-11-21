// One bounded stdin document in a short-lived, credential-free child. No URL,
// attachments, rendering, actions or logging. The parent caps time/output too.
console.log = console.warn = console.error = () => {};
try {
  const { PDFParse } = await import('pdf-parse');
  const chunks = [];
  let size = 0;
  for await (const b of process.stdin) {
    size += b.length;
    if (size > 2 * 1024 * 1024) process.exit(2);
    chunks.push(b);
  }
  const parser = new PDFParse({
    data: Buffer.concat(chunks),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
    stopAtErrors: true,
  });
  try {
    const { text } = await parser.getText({ partial: [1], pageJoiner: '' });
    process.stdout.write(text.slice(0, 4096));
  } finally {
    await parser.destroy();
  }
} catch {
  process.exitCode = 1;
}
