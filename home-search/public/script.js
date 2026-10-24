$(document).ready(function() {
    //Get the input, send button, and response box
    const input = $('#promptInput');
    const form = $('#promptForm');
    const sendbtn = $('#send');
    const output = $('#response-box');

    //History of conversation 
    const history = [];

    //Gets the filters applied 
    function getFilters() {
        const filters = {
            location: $('#filterCity').val().trim(),
            radius: Number($('#filterRadius').val())
        };

        if ($('#petFriendly').is(':checked')) {
            filters.pets = {
                dogs: $('#petDogs').is(':checked'),
                cats: $('#petCats').is(':checked')
            };
        }

        return filters;
    }
    //Send question when send btn is clicked 
    form.on('submit', async(e) => {
        e.preventDefault();

        //Get the question, format it, and check it 
        const question = input.val().trim();
        if (!question) return; 

        //Clear the input
        input.val('');

        //Change panels if 1st question
        $('#budget-empty').hide();
        output.show();

        //Change the text while wating for a answer and disable the send button
        output.text('Thinking...');
        sendbtn.prop('disabled', true);

        //Try and send the request to Gemma 
        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, filters: getFilters(), history })
            });
            const data= await response.json();

            //Put response in the output 
            if (response .ok) {
                //Styles response (markdown -> html)
                const html = DOMPurify.sanitize(marked.parse(data.answer));
                output.html(html);
            }
            else {
                output.text(data.error);
            }

            //Add this exchange to the history but only if it works 
            if (response.ok) {
                history.push({ role: 'user', text: question });
                history.push({ role: 'model', text: data.answer });
            }
        }
        catch (err) {
            output.text(`Couldn't reach the server.`);
        }
        finally {
            //Reenable the sendbtn
            sendbtn.prop('disabled', false);
        }
    });

    //Send question when enter is pressed
    input.on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            form[0].requestSubmit();
        }
    });

});