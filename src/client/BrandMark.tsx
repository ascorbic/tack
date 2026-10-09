/** The Tack mark: a sticky note, pinned with a tack. */
export function BrandMark({ size = 24 }: { size?: number }) {
	return (
		<svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
			<g className="brand-mark-note">
				<path d="M4.5 6.5h15v12.2l-3.3 3.3H4.5z" fill="#ffd85c" />
				<path d="M16.2 22v-3.3h3.3z" fill="#e8b93a" />
			</g>
			<g className="brand-mark-pin">
				<ellipse cx="12.6" cy="9.4" rx="3.1" ry="1.3" fill="rgb(0 0 0 / 18%)" />
				<circle cx="12" cy="7" r="3.4" fill="#e5533d" />
				<circle cx="10.9" cy="5.9" r="1.1" fill="rgb(255 255 255 / 55%)" />
			</g>
		</svg>
	);
}
