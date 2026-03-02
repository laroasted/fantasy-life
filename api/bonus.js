const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
 res.setHeader('Access-Control-Allow-Origin', '*');

 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

 const { category, member, points, detail, enteredBy } = req.body;

 if (!category || !member || points === undefined || !detail) {
  return res.status(400).json({ error: 'Missing required fields: category, member, points, detail' });
 }

 const { error: bonusError } = await supabase
  .from('bonus_points')
  .upsert({
   category,
   member,
   points: parseInt(points),
   detail,
   entered_by: enteredBy || 'anonymous'
  }, { onConflict: 'category,member' });

 if (bonusError) return res.status(500).json({ error: bonusError.message });

 const { error: scoreError } = await supabase
  .from('scores')
  .update({ bonus: parseInt(points) })
  .eq('category', category)
  .eq('member', member);

 if (scoreError) return res.status(500).json({ error: scoreError.message });

 return res.status(200).json({ success: true, message: `${points} bonus pts added for ${member} in ${category}` });
};