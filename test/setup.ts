import { memoryKeyStore, setKeyStore } from "../src/providers/keys.ts";

setKeyStore(memoryKeyStore());
