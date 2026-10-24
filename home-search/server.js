import 'dotenv/config'; //Read out of .env
import express from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { readFile } from 'fs/promises';

//Create client 
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(express.json());
app.use(express.static('public'));

//Model and instructions
const model = 'gemma-4-26b-a4b-it';
const instructions = `
  You are helping a person budget for a new place to live and moving.
  Keep answer clear, useful and under 250 words.
  If the user asks about homes and no location is given,
  ask them for a city, neighborhood, or ZIP code before anything else.
  A city, neighborhood, or ZIP code alone is enough to search. When one is given,
  call search_listings right away instead of asking for more details.
  Never make up specific listings, addresses, or prices.
`;

//Load the sample listings 
const raw = await readFile('./data/listings.json', 'utf-8');
const { listings } = JSON.parse(raw);
console.log(`Loaded ${listings.length} listings`);

//Calulates the distance in miles between to lat/log points 
function distance(lat1, lng1, lat2, lng2)
{
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3959; //Earth's radius in miles

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

//Clean up locations 
function cleanLoc(input) {
  const text = input.toLowerCase().trim();

  //Use 5 digit ZIP codes
  const zip = text.match(/\b\d{5}\b/);
  if (zip) {
    return zip[0];
  }

  //Just look at the city 
  return text.split(',')[0].trim().replace(/\s+[a-z]{2}$/, '');
}


//Search for houses based on the filters Gemma sends 
function searchListings({ location, listingType, maxPrice, pets, radius}) {
  //Require a location 
  if (!location){
    return {error: 'A location is required. Ask the user for a city, neighborhood, or ZIP code.'};
  }

  const loc = cleanLoc(location);
  const isZip = /^\d{5}$/.test(loc);

  //Match by name
  let nameMatches = listings.filter((home) =>
    isZip
      ? home.zip === loc
      : [home.city, home.neighborhood].some((value) => value.toLowerCase().includes(loc))
  );

  if (isZip && nameMatches.length === 0) {
    nameMatches = listings.filter((home) => home.zip.startsWith(loc.slice(0, 3)));
  }

  //If nothing matches, no center for radius 
  if (nameMatches.length === 0)
  {
    return { count: 0, homes:[] };
  }

  //Calculate the center point 
  const center = { 
    lat: nameMatches.reduce((sum, home) => sum + home.lat, 0) / nameMatches.length,
    lng: nameMatches.reduce((sum, home) => sum + home.lng, 0) / nameMatches.length,
  };

  //Filter the listings based on the filters 
  const homes = listings.filter((home) => {
    const matchesLoc = radius ? distance(center.lat, center.lng, home.lat, home.lng) <= radius : nameMatches.includes(home);
    const matchesType = !listingType || home.listingType === listingType;
    const matchesPrice = !maxPrice || home.price <= maxPrice;
    const matchesPets = !pets || ((!pets.dogs || home.pets.dogs) && (!pets.cats || home.pets.cats));
   
    return matchesLoc && matchesType && matchesPrice && matchesPets;
  });

  return { count: homes.length, homes };
}

//Describes searchListing to Gemma 
const searchListingsDeclaration = {
  name: 'search_listings',
  description: 'Search available homes and apartments. Use this whenever the user wants to see listings.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: {
        type: Type.STRING,
        description: 'City name, neighborhood, or ZIP code, e.g. "Blacksburg" or "45202".',
      },
      listingType: {
        type: Type.STRING,
        enum: ['sale', 'rent'],
        description: '"sale" to buy, "rent" for monthly rentals.',
      },
      maxPrice: { type: Type.NUMBER, description: 'Maximum price in dollars.' },
    },
    required: ['location'],
  },
};

//Keep only valid and recent message 
function cleanHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.filter(msg => 
  (msg?.role === 'user' || msg?.role === 'model') && 
  typeof msg.text === 'string' &&
  msg.text.trim() !== '' 
  )
  .slice(-10);
}

//Sends the question to Gemma and ge the response 
async function askGemma(question, filters, history = []) {
  //Make the content 
  const content = filters.location ? `User's location: ${filters.location}\n\nQuestion: ${question}` : question;

  //Turn earlier messages into Gemm's format 
  const earlier = cleanHistory(history).map(msg => ({
    role: msg.role,
    parts:[{ text: msg.text }]
  }));

  //The conversation so far 
  const contents = [...earlier, { role: 'user', parts: [{ text: content }] }];
  console.log('Messages sent to Gemma:', contents.length);

  //Settings for the call to Gemma
  const config = {
    systemInstruction: instructions,
    maxOutputTokens: 500,
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.MINIMAL
    },
    tools: [{functionDeclarations: [searchListingsDeclaration] }]
  };

  //First call to Gemma: Gemma answers or asks for search
  const first = await  ai.models.generateContent({ model, contents, config });
  const call = first.functionCalls?.[0];

  //No search request 
  if (!call) {
    return first.text ?? 'Gemma did not return an answer';
  }

  //Run the search with the filters 
  const result = searchListings({ ...filters, ...call.args });
  console.log('Gemma asked for:', call.args, '| Result:', result.count ?? result.error);

  //Add Gemma's request and search results to the conversation 
  contents.push(first.candidates[0].content);
  contents.push({
    role: 'user',
    parts: [{ functionResponse: { name: call.name, response: result} }]
  });

  //Second call 
  const second = await ai.models.generateContent({ model, contents, config });
  //Return the answer
  return second.text ?? 'Gemma did not return an answer';
}

app.post('/chat', async (req, res) => {
  //Gets the question sent by the user 
  const { question, filters = {}, history = [] } = req.body;

  //Check for a question
  if (!question) {
    return res.status(400).json({ error: "Please ask a question."});
  }

  //Ask Gemma 
  try{
    const answer = await askGemma(question, filters, history);
    res.json({ answer });
  } 
  catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.listen(3000, () => {
  console.log('Server:  http://localhost:3000');
});