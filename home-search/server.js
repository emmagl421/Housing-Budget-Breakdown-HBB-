import 'dotenv/config'; //Read out of .env
import express from 'express';
import { GoogleGenAI, ThinkingLevel, Type, FunctionCallingConfigMode } from '@google/genai';
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
  Whenever the user asks to see or find homes, call search_listings, even if you searched earlier
  in the conversation. The homes panel on the page only updates when you call it.
  This does not apply when the user asks about one specific listing.
  Never make up specific listings, addresses, or prices.
  When the user wants a budget or asks whether they can afford a home, call calculate_budget.
  Only use a monthly income the user has actually stated in this conversation.
  If they stated it earlier, reuse it without asking again. If they never gave it, ask for it.
  When the user asks about a specific listing, always pass its id as listingId, never its price.
  Listing ids are not saved between messages, so if the listing came from an earlier answer,
  call search_listings again to get its id before calling calculate_budget.
  Never do budget math yourself. Only use numbers that calculate_budget returns.
  Show the breakdown with short headings for monthly costs and upfront costs,
  and mention the assumptions it lists. Say these are estimates, not financial advice.
  If the user's message includes a listing id, do not call search_listings. Use the id as
  listingId directly. If you don't know their income yet, ask for it first.
  When the user wants to save for a home, asks how long saving will take, or asks how to budget
  for a move, call plan_savings. If it returns an error asking for information, ask the user for it.
  Show the monthly spending plan as a short list, and say the category amounts are typical
  estimates they can adjust to their real costs.
  When the user asks to redo or change a savings plan, call plan_savings again with the same
  details from earlier in the conversation. Never recalculate a plan yourself.
  If status is "tight", say so kindly and mention comfortableTimeline as a gentler option.
  If status is "not realistic", don't present the plan as doable. Give the monthly amount and
  number of months from comfortableTimeline, or suggest looking at a less expensive home.
  A donut chart of the monthly breakdown is shown with your answer automatically. Don't draw one.
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
function searchListings({ location, listingType, maxPrice, minSalePrice, maxSalePrice, pets, radius }) {  //Require a location 
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
    const matchesSalePrice = home.listingType !== 'sale' || (
      (!minSalePrice || home.price >= minSalePrice) &&
      (!maxSalePrice || home.price <= maxSalePrice)
    );
    return matchesLoc && matchesType && matchesPrice && matchesPets && matchesSalePrice;  });

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

//Default buying assumptions 
const assumptions = {
  interestRate: 6.5,
  loanYears: 30,
  downPaymentPercent: 20,
  closingCostPercent: 3
};

//Calculate a monthly budget for a home
function calculateBudget({
  listingId,
  monthlyIncome, 
  housingCost, 
  listingType = 'rent',
  downPaymentPercent = assumptions.downPaymentPercent,
  interestRate = assumptions.interestRate,
  movingCost = 0
}) {
  //Uses any isting Gemma names 
  let home = null;
  if (listingId) {
    home = listings.find((listing) => listing.id === listingId);
    if (!home) {
       return { error: `No listing with id ${listingId}. Call search_listings to find the right one.` };
    }
    housingCost = home.price;
    listingType = home.listingType;
  }

  //Require monhtly income and housing cost 
  if (!monthlyIncome || monthlyIncome <= 0) {
    return { error: 'Monthly income is required. Ask the user for it.' };
  }
  if (!housingCost || housingCost <= 0) {
    return { error: 'A listing or a price is required. Ask the user which home or what price.' };
  }

  let monthlyHousing;
  let upfront;

  if (listingType === 'sale') {
    const downPayment = housingCost * downPaymentPercent / 100;
    const loan = housingCost - downPayment;
    const r = interestRate / 100 /12;
    const n = assumptions.loanYears * 12;
    monthlyHousing = r === 0? loan / n : loan * r * (1 + r) ** n / ((1 + r) ** n - 1 );

    upfront = {
      downPayment: Math.round(downPayment),
      closingCosts: Math.round(housingCost * assumptions.closingCostPercent / 100),
      moving: Math.round(movingCost)
    };
  }
  else {
    //Rent cost 
    monthlyHousing = housingCost;
    upfront = {
      firstMonthRent: Math.round(housingCost),
      securityDeposit: Math.round(housingCost),
      moving: Math.round(movingCost),
    };
  }

  const needs = monthlyIncome * 0.5;

const result = {
    monthlyIncome: Math.round(monthlyIncome),
    monthlyHousing: Math.round(monthlyHousing),
    housingPercentOfIncome: Math.round(monthlyHousing / monthlyIncome * 100),
    recommendedMaxHousing: Math.round(monthlyIncome * 0.3),
    split: {
      needs: Math.round(needs),
      needsLeftAfterHousing: Math.round(needs - monthlyHousing),
      wants: Math.round(monthlyIncome * 0.3),
      savings: Math.round(monthlyIncome * 0.2),
    },
    upfront,
    upfrontTotal: Object.values(upfront).reduce((sum, value) => sum + value, 0),
    assumptions: listingType === 'sale'
      ? {
          interestRate,
          loanYears: assumptions.loanYears,
          downPaymentPercent,
          closingCostPercent: assumptions.closingCostPercent,
          note: 'Mortgage payment does not include property tax, insurance, or HOA fees.',
        }
      : { note: 'Security deposit estimated as one month of rent.' },
  };

  //Only include listing if there is one 
  if (home) {
    result.listing = { id: home.id, address: home.address, listingType: home.listingType };
  }

  return result;
}

//Describes calculateBudget to Gemma
const calculateBudgetDeclaration = {
  name: 'calculate_budget',
  description: 'Calculate a monthly budget and upfront move-in costs for a home. Use this whenever the user wants a budget breakdown or asks whether they can afford a home.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      listingId: {
        type: Type.STRING,
        description: 'The id of a listing from search_listings, e.g. "bb-005". Use this whenever the user asks about a specific listing.',
      },
      monthlyIncome: {
        type: Type.NUMBER,
        description: 'Monthly take-home (after-tax) income in dollars.',
      },
      housingCost: {
        type: Type.NUMBER,
        description: 'Only for a price the user typed themselves, never for a listing. For a listing, use listingId.',
      },
      listingType: {
        type: Type.STRING,
        enum: ['sale', 'rent'],
        description: 'Only if there is no listingId: "rent" if housingCost is monthly rent, "sale" if it is a purchase price.',
      },
      downPaymentPercent: {
        type: Type.NUMBER,
        description: 'Down payment percent, only if the user gives one.',
      },
      interestRate: {
        type: Type.NUMBER,
        description: 'Yearly mortgage interest rate in percent, only if the user gives one.',
      },
      movingCost: {
        type: Type.NUMBER,
        description: 'Estimated moving cost in dollars, only if the user gives one.',
      },
    },
    required: ['monthlyIncome'],
  },
};

//Typical monthly spending as a percent of take-home pay. Rough estimates; adjust as needed
const SPENDING_ESTIMATES = {
  groceries: 10,
  utilities: 5,        //Electric, water, internet, phone
  transportation: 10,  //Car payment, gas and insurance, or transit
  health: 5,           //Health insurance, prescriptions
};

const COMFORTABLE_SAVINGS_PERCENT = 20;  //The "20" in 50/30/20
const MAX_SAVINGS_PERCENT = 35;          //Beyond this, most budgets break

//Builds a savings plan for a home's upfront costs and a monthly spending plan
function planSavings({
  monthlyIncome,
  monthsToSave,
  currentHousingCost,
  currentSavings = 0,
  debtPayments = 0,
  ...homeArgs   //listingId, housingCost, listingType, etc. Passed on to calculateBudget
}) {
  if (!monthsToSave || monthsToSave <= 0) {
    return { error: 'The number of months the user has to save is required. Ask the user.' };
  }
  if (currentHousingCost === undefined || currentHousingCost < 0) {
    return { error: 'What the user pays for housing now is required (0 if nothing). Ask the user.' };
  }

  //Reuse calculateBudget, so upfront costs are calculated in only one place
  const home = calculateBudget({ monthlyIncome, ...homeArgs });
  if (home.error) return home;

  const income = Math.round(monthlyIncome);
  const goal = home.upfrontTotal;
  const stillNeeded = Math.max(goal - currentSavings, 0);
  const monthlySavings = Math.ceil(stillNeeded / monthsToSave);  //Round up so they reach the goal

  //Essentials, estimated from income and rounded first so the plan adds up exactly
  const essentials = {};
  for (const [name, percent] of Object.entries(SPENDING_ESTIMATES)) {
    essentials[name] = Math.round(income * percent / 100);
  }
  const essentialsTotal = Object.values(essentials).reduce((sum, value) => sum + value, 0);

  const housingNow = Math.round(currentHousingCost);
  const debt = Math.round(debtPayments);
  const flexible = income - housingNow - debt - essentialsTotal - monthlySavings;
  const savingsPercent = Math.round(monthlySavings / income * 100);

  let status;
  if (flexible < 0 || savingsPercent > MAX_SAVINGS_PERCENT) status = 'not realistic';
  else if (savingsPercent > COMFORTABLE_SAVINGS_PERCENT) status = 'tight';
  else status = 'comfortable';

  //How long it would take saving a comfortable 20% of income
  const comfortableMonthly = Math.round(income * COMFORTABLE_SAVINGS_PERCENT / 100);
  const comfortableMonths = Math.ceil(stillNeeded / comfortableMonthly);

  const result = {
    status,
    savingsGoal: {
      upfrontTotal: goal,
      upfrontBreakdown: home.upfront,
      alreadySaved: Math.round(currentSavings),
      stillNeeded: Math.round(stillNeeded),
      monthsToSave,
      monthlySavingsNeeded: monthlySavings,
      savingsPercentOfIncome: savingsPercent,
    },
    monthlySpendingPlan: {
      income,
      currentHousing: housingNow,
      debtPayments: debt,
      ...essentials,
      savingsForHome: monthlySavings,
      flexibleSpending: flexible,   //Wants: eating out, entertainment, shopping
    },
    comfortableTimeline: {
      monthlySavings: comfortableMonthly,
      months: comfortableMonths,
    },
    afterMoving: {
      monthlyHousing: home.monthlyHousing,
      housingPercentOfIncome: home.housingPercentOfIncome,
    },
    notes: [
      'Groceries, utilities, transportation and health are typical estimates, not the user\'s real costs.',
      ...Object.values(home.assumptions ?? {}),
    ],
  };

  //Only include the listing when there is one (no nulls, which helped with the 500 errors)
  if (home.listing) result.listing = home.listing;

  return result;
}

//Description of planSavings for Gemma 
const planSavingsDeclaration = {
  name: 'plan_savings',
  description: 'Builds a plan to save for the upfront costs of a home (deposit and first month, or down payment and closing costs) within a number of months, plus a monthly spending plan to get there. Use when the user wants to start saving, asks how long saving will take, or asks how to budget for a move.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      //Same listing, price and income fields as calculate_budget
      ...calculateBudgetDeclaration.parameters.properties,
      monthsToSave: {
        type: Type.NUMBER,
        description: 'How many months the user has to save, only if the user says.',
      },
      currentHousingCost: {
        type: Type.NUMBER,
        description: 'What the user pays for housing now each month. 0 if they pay nothing, e.g. living with family.',
      },
      currentSavings: {
        type: Type.NUMBER,
        description: 'Money already saved toward the move, only if the user says.',
      },
      debtPayments: {
        type: Type.NUMBER,
        description: 'Total monthly minimum debt payments (student loans, credit cards), only if the user says.',
      },
    },
    required: ['monthlyIncome'],
  },
};

//Friendly names for the spending plan, in the order they appear in the chart
const CHART_LABELS = {
  currentHousing: 'Housing now',
  debtPayments: 'Debt payments',
  groceries: 'Groceries',
  utilities: 'Utilities',
  transportation: 'Transportation',
  health: 'Health',
  savingsForHome: 'Savings for the move',
  flexibleSpending: 'Flexible spending',
};

//Turns a budget or savings result into donut chart data, or undefined if there's nothing to chart
function buildChart(name, result) {
  if (result.error) return undefined;

  if (name === 'plan_savings') {
    const plan = result.monthlySpendingPlan;
    const labels = [];
    const values = [];
    for (const [key, label] of Object.entries(CHART_LABELS)) {
      if (plan[key] > 0) {   //A donut can't show zero or negative slices
        labels.push(label);
        values.push(plan[key]);
      }
    }
    return {
      kind: 'savings',
      months: result.savingsGoal.monthsToSave,
      title: `Monthly plan while saving: $${plan.income.toLocaleString()}`,
      labels,
      values,
      overBy: plan.flexibleSpending < 0 ? -plan.flexibleSpending : undefined,
    };
  }

  if (name === 'calculate_budget') {
    const income = result.monthlyIncome;
    const housing = result.monthlyHousing;
    const title = `Monthly budget after moving: $${income.toLocaleString()}`;
    let left = income - housing;

    //Housing alone costs more than the income
    if (left < 0) {
      return { title, labels: ['Housing'], values: [housing], overBy: -left };
    }

    //Split what's left using 50/30/20. Expensive housing takes from wants first, then savings
    const otherNeeds = Math.min(Math.max(result.split.needs - housing, 0), left);
    left -= otherNeeds;
    const savings = Math.min(result.split.savings, left);
    const wants = left - savings;

    const slices = [['Housing', housing], ['Other needs', otherNeeds], ['Wants', wants], ['Savings', savings]]
      .filter(([, value]) => value > 0);

    return {
      title,
      labels: slices.map(([label]) => label),
      values: slices.map(([, value]) => value),
    };
  }

  return undefined;
}

//Calls Gemma, retrying up to 2 more times if Google's server has a temporary error
async function generate(request, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      //Only retry server errors (500s), not mistakes in the request (400s)
      if (err.status >= 500 && attempt < attempts) {
        console.log(`Google server error, trying again (${attempt} of ${attempts - 1})...`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
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

    //Everything the user has typed, without $ and commas, so "$3,200" can match 3200
  const userText = [...cleanHistory(history).filter((msg) => msg.role === 'user').map((msg) => msg.text), question]
    .join(' ')
    .replace(/[$,]/g, '');

  //Rejects an income the user never typed, so Gemma has to ask instead of guessing
  function checkIncome(args) {
      if (args.monthlyIncome && !new RegExp(`\\b${args.monthlyIncome}\\b`).test(userText)) {
      return { error: 'The user has not stated this income. Ask the user for their monthly take-home income.' };
    }
    return null;
  }

  //Settings for the call to Gemma
  const config = {
    systemInstruction: instructions,
    maxOutputTokens: 800,
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.MINIMAL
    },
    tools: [{ functionDeclarations: [searchListingsDeclaration, calculateBudgetDeclaration, planSavingsDeclaration] }]  
  };

  //Keep the savings timeline out of the search filters
  const { savingsMonths, ...searchFilters } = filters;

  //The functions Gemma is allowed to ask for, by name
  const toolFunctions = {
    search_listings: (args) => searchListings({ ...searchFilters, ...args }),
    calculate_budget: (args) => checkIncome(args) ?? calculateBudget(args),
    plan_savings: (args) => checkIncome(args) ?? planSavings({ ...args, monthsToSave: savingsMonths ?? args.monthsToSave })
  };

  //Settings that require Gemma to answer with text instead of asking for a function
  const answerNow = {
    ...config,
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } }
  };

  //Allows or repeat calls 
  const alreadyRun = new Set();

  //Homes from most recent search 
  let foundHomes; 

  //What Gemma searched for most recently (location, listingType, maxPrice)
  let searchArgs;

  //Chart data from the most recent budget or savings plan
  let chart;

  //First call to Gemma: Answer or ask for function
  let response = await generate({ model, contents, config });

  for (let round = 0; round < 3; round++) {
    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      break;
    }

    //Add Gemma's request to convo
    contents.push(response.candidates[0].content);

    //Run functions Gemma asked for
    let repeated = false;
    const parts = calls.map((call) => {
      const args = call.args ?? {};

      //Repeat calls = same function, same params
      const key = call.name + JSON.stringify(Object.entries(args).sort());
      if (alreadyRun.has(key)) {
        repeated = true;
      }
      alreadyRun.add(key);

      const run = toolFunctions[call.name];
      const result = run ? run(args) : { error: `Unknown function: ${call.name}` };
      console.log(`Gemma asked for ${call.name}:`, args, '→', result.error ?? 'ok');

      //Keep the homes from the search to be sent ot the site 
      if (call.name === 'search_listings' && result.homes) {
        foundHomes = result.homes;
        searchArgs = args;
      }

      //Keep chart data from budgets and savings plans
      const built = buildChart(call.name, result);
      if (built) {
        chart = built;
      }

      //Send id to Gemma so it can match result to request 
      return { functionResponse: { id: call.id, name: call.name, response: result } };
    });

    //Send results back
    contents.push({ role: 'user', parts });

    //If Gemma is repeating itself/this is last round -> require text answer
    const lastRound = round === 2;
    response = await generate({
      model,
      contents,
      config: repeated || lastRound ? answerNow : config
    });
  }

  //Return answer 
  return {
    answer: response.text ?? 'Gemma did not return an answer',
    homes: foundHomes,
    chart,
    searchArgs,
  };
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
    const { answer, homes, chart, searchArgs } = await askGemma(question, filters, history);
    res.json({ answer, homes, chart, searchArgs });
  } 
  catch (err) {
    console.error(err);

    //Google's server failed even after retrying
    if (err.status >= 500) {
      return res.status(503).json({ error: "Gemma's server had a temporary problem. Please try your question again." });
    }

    res.status(500).json({ error: "Something went wrong." });
  }
});

//Searches listings directly from the sidebar, without Gemma
app.post('/search', (req, res) => {
  const { filters = {} } = req.body;
  const result = searchListings(filters);

  if (result.error) {
    return res.status(400).json({ error: 'Enter a city, neighborhood, or ZIP code first.' });
  }

  res.json({ homes: result.homes });
});

app.listen(3000, () => {
  console.log('Server:  http://localhost:3000');
});