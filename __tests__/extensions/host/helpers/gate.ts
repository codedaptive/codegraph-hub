/** A promise a test opens by hand. */
export class Gate {
  readonly promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((r) => { this.open = r; }); }
}
