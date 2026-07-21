const fetch = require('node-fetch');

const META_GRAPH = 'https://graph.facebook.com/v19.0';

// ── Facebook Pages ────────────────────────────────────────────────────────
async function getFacebookPages(userAccessToken) {
  const res = await fetch(`${META_GRAPH}/me/accounts?access_token=${userAccessToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.data; // Array of pages with id, name, access_token
}

async function getFacebookPageMetrics(pageId, pageAccessToken) {
  // Get fan count and basic fields
  const res = await fetch(`${META_GRAPH}/${pageId}?fields=fan_count,followers_count,name&access_token=${pageAccessToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Get insights (reach, engaged users, page views)
  const insightsRes = await fetch(
    `${META_GRAPH}/${pageId}/insights?metric=page_impressions,page_engaged_users,page_views_total&period=day&access_token=${pageAccessToken}`
  );
  const insightsData = await insightsRes.json();
  
  let reach = 0, engagement = 0, views = 0;
  if (!insightsData.error && insightsData.data) {
    const getMetric = (name) => {
      const metric = insightsData.data.find(m => m.name === name);
      // Sum last 3 days for a quick snapshot, or just take the latest
      if (metric && metric.values && metric.values.length > 0) {
        return metric.values[metric.values.length - 1].value || 0;
      }
      return 0;
    };
    reach = getMetric('page_impressions');
    engagement = getMetric('page_engaged_users');
    views = getMetric('page_views_total');
  }

  // Calculate engagement rate
  const followers = data.fan_count || data.followers_count || 0;
  const engagementRate = followers > 0 ? (engagement / followers) * 100 : 0;

  return {
    followers,
    posts_30d: 0, // Requires querying posts feed, omitting for speed unless requested
    avg_reach: reach,
    engagement: engagementRate,
    impressions: reach,
    views: views
  };
}

// ── Instagram Business ───────────────────────────────────────────────────
async function getInstagramAccount(pageId, pageAccessToken) {
  const res = await fetch(`${META_GRAPH}/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.instagram_business_account; // { id: '...' }
}

async function getInstagramMetrics(igAccountId, pageAccessToken) {
  const res = await fetch(
    `${META_GRAPH}/${igAccountId}?fields=followers_count,media_count,profile_views&access_token=${pageAccessToken}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  return {
    followers: data.followers_count || 0,
    posts_30d: data.media_count || 0, // Total media for now
    avg_reach: 0, // Needs deep insights API
    engagement: 0, // Needs deep insights API
    impressions: 0,
    views: data.profile_views || 0
  };
}

// ── YouTube (Google API) ────────────────────────────────────────────────
async function getYouTubeMetrics(accessToken) {
  // First get the channel ID for the authenticated user
  const channelRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const channelData = await channelRes.json();
  if (channelData.error) throw new Error(channelData.error.message);

  if (!channelData.items || channelData.items.length === 0) {
    throw new Error('No YouTube channel found for this account.');
  }

  const stats = channelData.items[0].statistics;
  return {
    followers: parseInt(stats.subscriberCount || 0, 10),
    posts_30d: parseInt(stats.videoCount || 0, 10),
    avg_reach: 0,
    engagement: 0,
    impressions: 0,
    views: parseInt(stats.viewCount || 0, 10)
  };
}

// ── LinkedIn ────────────────────────────────────────────────────────────
async function getLinkedInCompanyMetrics(accessToken, organizationUrn) {
  // This requires r_organization_social_analytics scope
  try {
    const res = await fetch(`https://api.linkedin.com/rest/networkSizes/${organizationUrn}?edgeType=CompanyFollowedByMember`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202308' // Use a recent version
      }
    });
    const data = await res.json();
    if (data.status >= 400) throw new Error(data.message);
    
    return {
      followers: data.firstDegreeSize || 0,
      posts_30d: 0,
      avg_reach: 0,
      engagement: 0,
      impressions: 0,
      views: 0
    };
  } catch (err) {
    console.error('LinkedIn API error:', err);
    throw err;
  }
}

// ── Twitter / X ─────────────────────────────────────────────────────────
async function getTwitterMetrics(handle, bearerToken) {
  const cleanHandle = handle.replace('@', '');
  const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanHandle}?user.fields=public_metrics`, {
    headers: { Authorization: `Bearer ${bearerToken}` }
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].detail);
  if (!data.data) throw new Error('User not found');

  const metrics = data.data.public_metrics;
  return {
    followers: metrics.followers_count || 0,
    posts_30d: metrics.tweet_count || 0, // total tweets
    avg_reach: 0,
    engagement: 0,
    impressions: 0,
    views: 0
  };
}

module.exports = {
  getFacebookPages,
  getFacebookPageMetrics,
  getInstagramAccount,
  getInstagramMetrics,
  getYouTubeMetrics,
  getLinkedInCompanyMetrics,
  getTwitterMetrics
};
