const { serviceClient, anonClient } = require('./supabase');

async function verifyUser(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const { data: { user }, error } = await anonClient().auth.getUser(token);
    if (error || !user) return null;
    return user;
}

async function verifyApprovedUser(req) {
    const user = await verifyUser(req);
    if (!user) return { user: null, approved: false };

    const { data: profile } = await serviceClient()
        .from('tl_profiles')
        .select('approved')
        .eq('id', user.id)
        .single();

    return { user, approved: profile?.approved === true };
}

module.exports = { verifyUser, verifyApprovedUser };
