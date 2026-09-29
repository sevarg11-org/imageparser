import { useCallback, useEffect, useRef, useState } from 'react'
import './DirectoryBrowser.css'

export type DirectoryListing = {
  path: string
  rootPath: string
  parent: string | null
  directories: { name: string; path: string }[]
  imageCount: number
}

type DirectoryBrowserProps = {
  initialPath: string | null
  loadListing: (directoryPath: string | null) => Promise<DirectoryListing>
  onClose: (selectedPath: string | null) => void
}

const toDisplayPath = (listing: DirectoryListing) => {
  if (listing.path === listing.rootPath) {
    return '/'
  }

  return listing.path.slice(listing.rootPath.length).replace(/\\/g, '/') || '/'
}

export const DirectoryBrowserDialog = ({ initialPath, loadListing, onClose }: DirectoryBrowserProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const navigate = useCallback(async (directoryPath: string | null) => {
    setIsLoading(true)
    setError('')
    try {
      setListing(await loadListing(directoryPath))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to open that folder.')
    } finally {
      setIsLoading(false)
    }
  }, [loadListing])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) {
      dialog.showModal()
    }

    void (async () => {
      try {
        setListing(await loadListing(initialPath))
      } catch {
        // The remembered folder may have been removed; fall back to the share root.
        try {
          setListing(await loadListing(null))
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to open the shared folder.')
        }
      } finally {
        setIsLoading(false)
      }
    })()
  }, [initialPath, loadListing])

  return (
    <dialog
      ref={dialogRef}
      className="directory-browser"
      aria-labelledby="directory-browser-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose(null)
      }}
    >
      <header className="directory-browser-header">
        <h2 id="directory-browser-title">Select image folder</h2>
        <p className="directory-browser-path" aria-live="polite">
          {listing ? toDisplayPath(listing) : 'Loading...'}
        </p>
      </header>

      <div className="directory-browser-body" aria-busy={isLoading}>
        {error ? <p role="alert" className="directory-browser-error">{error}</p> : null}
        <ul className="directory-browser-list">
          {listing?.parent ? (
            <li>
              <button type="button" disabled={isLoading} onClick={() => void navigate(listing.parent)}>
                <span aria-hidden="true">↑</span> Parent folder
              </button>
            </li>
          ) : null}
          {listing?.directories.map((directory) => (
            <li key={directory.path}>
              <button type="button" disabled={isLoading} onClick={() => void navigate(directory.path)}>
                <span aria-hidden="true">📁</span> {directory.name}
              </button>
            </li>
          ))}
          {listing && !listing.directories.length ? (
            <li className="directory-browser-empty">No subfolders</li>
          ) : null}
        </ul>
      </div>

      <footer className="directory-browser-footer">
        <span>
          {listing ? `${listing.imageCount} image${listing.imageCount === 1 ? '' : 's'} in this folder` : ''}
        </span>
        <div className="directory-browser-actions">
          <button type="button" className="secondary-button" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!listing || isLoading}
            onClick={() => listing && onClose(listing.path)}
          >
            Open this folder
          </button>
        </div>
      </footer>
    </dialog>
  )
}
