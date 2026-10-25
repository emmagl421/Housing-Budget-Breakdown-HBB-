# Housing-Budget-Breakdown
A AI powered website that helps you budget for a house/apartment
Powered by Gemma 4 
Model: gemma-4-26b-a4b-it

## How to use 
- Put in a location for a house 
    Then Gemma 4 will find houses that match your given location 
- Pick a listing you like and give Gemma a monthly budget
    Then Gemma 4 will create a more detailed account of costs 
- Filter by location or pet friendly
    Then Gemma 4 will find listings based on your preferences!
- Ask Gemma to make you a budget 
    Gemma will ask for a monthly income and create you budget based on your timeline 

## What Gemma does
Gemma gets input from the user and figures out what the user is asking for. 
Then, Gemma will run the functions it needs to or prompt the user for more information

## Information flow 
HTML -> script.js -> server.js -> SDK -> API -> Gemma 4

## Notes 
All listings and addresses are made up as I would need access to a API for real listings but the neighborhoods, ZIP codes, and coordinates are real

Because of this the way I find radius is not based on geocoding services but on the average position of every listing that matches the location by name 