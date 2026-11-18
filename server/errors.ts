/** An error whose message is safe to show the person using the site, with the HTTP status to send. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
