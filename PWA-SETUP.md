# PWA Setup Instructions

Your Anagram Jam application is now configured as a Progressive Web App (PWA)! 

## What's Been Added

1. **manifest.json** - Defines app metadata, icons, and display settings
2. **sw.js** - Service worker for offline functionality and caching
3. **PWA meta tags** - Added to both home and game pages
4. **Service worker registration** - Automatically registers on page load

## Generating Icons

To complete the PWA setup, you need to create icon files:

1. Open `generate-icons.html` in your browser
2. Click "Generate 192x192 Icon" and "Generate 512x512 Icon"
3. Click the download buttons to save the icons
4. Place the downloaded files (`icon-192.png` and `icon-512.png`) in the root directory of your project

Alternatively, you can create your own icons:
- `icon-192.png` - 192x192 pixels
- `icon-512.png` - 512x512 pixels
- Place them in the project root directory

## Testing the PWA

1. Start your server: `npm start`
2. Open the app in Chrome/Edge
3. Open DevTools → Application tab
4. Check "Service Workers" to see if it's registered
5. Check "Manifest" to verify the manifest is loaded
6. Use "Add to Home Screen" to test installation

## Features

- **Offline Support**: Static assets are cached for offline use
- **App-like Experience**: Can be installed on devices
- **Fast Loading**: Cached assets load instantly
- **Socket.io Compatible**: Real-time features still work (not cached)

## Notes

- The service worker uses a network-first strategy for HTML pages to ensure fresh content
- Socket.io connections are not cached and work normally
- Static assets (CSS, JS) are cached for faster loading
- Update the cache version in `sw.js` (CACHE_NAME) when you update assets

