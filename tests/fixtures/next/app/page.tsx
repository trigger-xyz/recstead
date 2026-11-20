import Link from 'next/link';
import { getCapabilities } from 'recstead';
import { VoiceRecorder } from './recorder';

// Render per request, so the response proves the hooks render on the server.
export const dynamic = 'force-dynamic';

export default function Page() {
  // The core is safe to import and call from a server component.
  const capabilities = getCapabilities();
  return <main>
    <h1>Recstead Next.js fixture</h1>
    <p>Rendered on: {capabilities.environment}</p>
    <VoiceRecorder />
    <Link href="/other">Other page</Link>
  </main>;
}
