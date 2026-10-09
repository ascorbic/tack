// Who is making a request. Implemented by the sign-in work (#4); until then
// everyone is anonymous.

export interface Viewer {
	/** GitHub user id. */
	id: number;
	login: string;
	name: string | null;
	avatarUrl: string;
}

/** The signed-in viewer for a request (HTTP or WebSocket upgrade), if any. */
export async function getViewer(_request: Request, _env: Env): Promise<Viewer | null> {
	return null;
}

/**
 * The viewer's own GitHub token (user-to-server), for checks that must use
 * their permissions, such as whether they can read a private repo (#10).
 */
export async function viewerToken(_env: Env, _viewer: Viewer): Promise<string | null> {
	return null;
}
