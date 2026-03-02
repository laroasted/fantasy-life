const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .order('category')
    .order('baseline', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const byMember = {};
  data.forEach(row => {
    if (!byMember[row.member]) byMember[row.member] = { total: 0, categories: {} };
    byMember[row.member].categories[row.category] = row;
    byMember[row.member].total += row.total;
  });

  return res.status(200).json({
    scores: byMember,
    raw: data,
    updatedAt: data[0]?.updated_at || null
  });
};