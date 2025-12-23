import { google } from 'googleapis';

export async function createCalendarClient(tokens: { access_token: string; refresh_token?: string }) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in environment variables');
    }

    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground' // redirect_uri
    );


    client.setCredentials(tokens); // access + refresh token

    // Automatically refresh tokens when they expire
    client.on('tokens', (newTokens) => {
        if (newTokens.refresh_token) {
            console.log('🔄 Google OAuth tokens refreshed');
            // In production, you should save these tokens to persistent storage
        }
    });

    return google.calendar({ version: 'v3', auth: client });
}
