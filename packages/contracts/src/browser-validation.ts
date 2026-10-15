import { z } from 'zod';

// Run before schema construction: Zod's optional JIT probes use Function(),
// which emits CSP violations even when the library catches the resulting error.
if (typeof window !== 'undefined') z.config({ jitless: true });
