// Vercel serverless function: hands the browser the public Supabase settings
// from your Vercel Environment Variables, so nothing needs editing in code.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    companyName: process.env.COMPANY_NAME || '',
  });
};
