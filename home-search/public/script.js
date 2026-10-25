$(document).ready(function() {
    //Get the input, send button, and response box
    const input = $('#promptInput');
    const form = $('#promptForm');
    const sendbtn = $('#send');
    const output = $('#response-box');

    //History of conversation 
    const history = [];

    const houseList = $("#house-list");

    //Formats money as dollars 
    const money = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
    });

    //True while waiting for Gemma 
    let busy = false;

    //What Gemma searched for most recently, so filters can rerun it
    let lastSearchArgs = null;

    //Months used in the last savings plan, so filters can redo it with a new timeline
    let lastPlanMonths = null;

    //Builds the cards for the houses side
    function renderHomes(homes) {
        //Not a search -> keep current cards 
        if (!Array.isArray(homes)) {
            return;
        }

        $('#house-empty').hide();
        houseList.empty().show();

        if (homes.length === 0) {
            houseList.append($('<p class="house-none">').text('No homes match your search.'));
            return;
        }

        for (const home of homes) {
            const price = home.listingType === 'rent' ? `${money.format(home.price)}/mo` : money.format(home.price);

            const card = $('<button type="button" class="house-card">').attr('data-id', home.id);

            card.append(
                $('<div class="house-card-top">').append(
                    $('<span class="house-badge">').text(home.listingType === 'rent' ? 'For rent' : 'For sale'),
                    $('<span class="house-price">').text(price)
                ),
                $('<div class="house-address">').text(home.address),
                $('<div class="house-place">').text(`${home.neighborhood}, ${home.city}`),
                $('<div class="house-stats">').text(
                    `${home.bedrooms} bd · ${home.bathrooms} ba · ${home.sqft.toLocaleString()} sqft`
                ),
                $('<div class="house-cta">').text('Make my budget →')
            );

             houseList.append(card);
        }
    }

    //Draws a donut chart inside a bubble
    function renderChart(bubble, chart) {
        if (!chart) return;

        //Chart.js needs a container with a set height to size the chart
        const box = $('<div class="chart-box">');
        const canvas = $('<canvas>');
        box.append(canvas);

        //Put the chart after the first paragraph, or at the end if there isn't one
        const firstParagraph = bubble.children('p').first();
        if (firstParagraph.length) {
            box.insertAfter(firstParagraph);
        } else {
            bubble.append(box);
        }

        //Read the current theme's colors so the chart matches light or dark mode
        const styles = getComputedStyle(document.documentElement);
        const textColor = styles.getPropertyValue('--bs-body-color').trim();
        const bubbleColor = styles.getPropertyValue('--gemma-bubble-bg').trim();
        const accentColor = styles.getPropertyValue('--app-accent').trim();
        const chartColors = Array.from({ length: 8 }, (_, i) =>
            styles.getPropertyValue(`--chart-color-${i + 1}`).trim()
        );

        new Chart(canvas[0], {
            type: 'doughnut',
            data: {
                labels: chart.labels,
                datasets: [{
                    data: chart.values,
                    backgroundColor: chartColors,
                    borderColor: bubbleColor,   //Gaps between slices match the bubble
                    borderWidth: 2,
                }],
            },
            options: {
                maintainAspectRatio: false,
                cutout: '45%',                  //Size of the hole in the middle
                plugins: {
                    title: { display: true, text: chart.title, color: accentColor },
                    legend: { position: 'bottom', labels: { color: textColor } },
                    tooltip: {
                        callbacks: {
                            label: (item) => `${item.label}: ${money.format(item.raw)}`,
                        },
                    },
                },
            },
        });

        //Warn when spending is more than income
        if (chart.overBy) {
            box.after($('<p class="chart-warning">').text(
                `This plan is over budget by ${money.format(chart.overBy)} a month.`
            ));
        }
    }

    //Gets the filters applied 
    function getFilters() {
        const filters = {
            location: $('#filterCity').val().trim(),
            radius: Number($('#filterRadius').val()),
            minSalePrice: Number($('#minPrice').val()),
            maxSalePrice: Number($('#maxPrice').val()),
            savingsMonths: Number($('#filterSaveMonths').val()) || undefined
        };

        if ($('#petFriendly').is(':checked')) {
            filters.pets = {
                dogs: $('#petDogs').is(':checked'),
                cats: $('#petCats').is(':checked')
            };
        }

        return filters;
    }
       //Sends a question to the server and shows the answer
     async function ask(question, source = 'chat') {
        if (busy) return;
        busy = true;

        //Change panels if 1st question
        $('#budget-empty').hide();
        output.show();

        //Show the question on the right and a waiting bubble for Gemma on the left
        const userBubble = $('<div class="chat-bubble chat-user">').text(question);
        const answer = $('<div class="chat-bubble chat-gemma">').text('Thinking...');
        output.append(userBubble, answer);
        answer[0].scrollIntoView({ behavior: 'smooth', block: 'end' });

        //Disable the send button while waiting
        sendbtn.prop('disabled', true);

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, filters: getFilters(), history })
            });
            const data = await response.json();

            if (response.ok) {
                //Styles response (markdown -> html)
                answer.html(DOMPurify.sanitize(marked.parse(data.answer)));

                //Show a donut chart for budgets and savings plans
                renderChart(answer, data.chart);

                //Show any homes from a search as cards, but keep the list in place after a card click
                if (source !== 'card') {
                    renderHomes(data.homes);
                }

                //Remember chat questions that found homes, so filters can repeat them
                if (data.searchArgs) {
                    lastSearchArgs = data.searchArgs;
                }

                //Remember the timeline of the last savings plan
                if (data.chart?.kind === 'savings') {
                    lastPlanMonths = data.chart.months;
                }

                //Add this exchange to the history
                history.push({ role: 'user', text: question });
                history.push({ role: 'model', text: data.answer });
            }
            else {
                answer.text(data.error);
            }
        }
        catch (err) {
            answer.text(`Couldn't reach the server.`);
        }
        finally {
            busy = false;
            sendbtn.prop('disabled', false);
        }
    }

    //Send question when the form is submitted
    form.on('submit', (e) => {
        e.preventDefault();

        const question = input.val().trim();
        if (!question) return;

        input.val('');
        ask(question);
    });

    //Send question when enter is pressed
    input.on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            form[0].requestSubmit();
        }
    });

    //Make personal budget when card is clicked 
    houseList.on('click', '.house-card', function() {
        if (busy) {
            return;
        }

        const card = $(this);
        const id = card.attr('data-id');
        const address = card.find('.house-address').text();

        //Highlight chosen card
        houseList.find('.house-card').removeClass('selected');
        card.addClass('selected');

        ask(`Make me a personal budget for ${address} (listing id ${id}).`, 'card');
    });

        //---------- Sidebar filters ----------
    const minPrice = $('#minPrice');
    const maxPrice = $('#maxPrice');

    //Shows the slider values as dollars and keeps min below max
    function updatePriceLabels(changed) {
        if (Number(minPrice.val()) > Number(maxPrice.val())) {
            if (changed === 'min') {
                maxPrice.val(minPrice.val());
            } else {
                minPrice.val(maxPrice.val());
            }
        }
        $('#minPriceLabel').text(money.format(Number(minPrice.val())));
        $('#maxPriceLabel').text(money.format(Number(maxPrice.val())));
    }

    minPrice.on('input', () => updatePriceLabels('min'));
    maxPrice.on('input', () => updatePriceLabels('max'));

    //Show the Dogs and Cats options only when the pet switch is on
    $('#petFriendly').on('change', function () {
        $('#petTypes').toggleClass('d-none', !this.checked);
    });

    //Shows a message in the Houses panel
    function showHouseMessage(text) {
        $('#house-empty').hide();
        houseList.empty().show().append($('<p class="house-none">').text(text));
    }

    //Clear the red outline once the user starts typing a location
    $('#filterCity').on('input', function () {
        $(this).removeClass('is-invalid');
    });

    //Apply filters: search directly, without Gemma
        $('#applyFilters').on('click', async () => {
        //Start from Gemma's last search, and let the sidebar filters win
        const sidebar = getFilters();
        const filters = {
            ...lastSearchArgs,
            ...sidebar,
            location: sidebar.location || lastSearchArgs?.location,
        };

        //If a new timeline was picked, start a savings plan or redo the current one
        const months = sidebar.savingsMonths;
        const planChanged = months && months !== lastPlanMonths;
        if (planChanged) {
            const label = $('#filterSaveMonths option:selected').text();
            const selected = houseList.find('.house-card.selected');
            let message;

            if (lastPlanMonths) {
                message = `Redo my savings plan with a timeline of ${label}.`;
            } else if (selected.length) {
                const address = selected.find('.house-address').text();
                message = `Help me save for ${address} (listing id ${selected.attr('data-id')}) with a timeline of ${label}.`;
            } else {
                message = `Help me make a savings plan with a timeline of ${label}.`;
            }

            lastPlanMonths = months;   //Only ask once per timeline, even if Gemma doesn't make a new chart
            ask(message, 'filters');
        }

        if (!filters.location) {
            //Only the timeline changed, so there's no search to show a message about
            if (!planChanged) {
                showHouseMessage('Filters apply to a home search. Enter a city, neighborhood, or ZIP code in Location, or ask Gemma to find homes.');
                $('#filterCity').addClass('is-invalid').trigger('focus');
            }
            return;
        }

        try {
            const response = await fetch('/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters })
            });
            const data = await response.json();

            if (response.ok) {
                renderHomes(data.homes);
            } else {
                showHouseMessage(data.error);
            }
        }
        catch (err) {
            showHouseMessage(`Couldn't reach the server.`);
        }
    });

    //Reset: put every filter back to its starting value
    $('#resetFilters').on('click', () => {
        $('#filterCity').val('');
        $('#filterRadius').val('10');
        minPrice.val(100000);
        maxPrice.val(500000);
        updatePriceLabels();
        $('#petFriendly').prop('checked', false).trigger('change');
        $('#petDogs, #petCats').prop('checked', true);
        $('#filterSaveMonths').val('');
        lastSearchArgs = null;
    });

        //---------- Theme switcher ----------
    //Tells us whether the computer is set to dark mode
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const themeIcons = { light: 'bi-sun', dark: 'bi-moon-stars', system: 'bi-circle-half' };
    const themeLabels = { light: 'Light', dark: 'Dark', system: 'System' };

    //Reads the saved choice, or uses dark if there isn't a valid one
    function getSavedTheme() {
        try {
            const saved = localStorage.getItem('theme');
            return themeLabels[saved] ? saved : 'dark';
        } catch {
            return 'dark';
        }
    }

    //Applies a choice: 'light', 'dark', or 'system'
    function applyTheme(choice) {
        //System means "match the computer"
        const actual = choice === 'system'
            ? (darkQuery.matches ? 'dark' : 'light')
            : choice;

        document.documentElement.setAttribute('data-bs-theme', actual);

        //Update the button and mark the chosen option
        $('#themeIcon').attr('class', `bi ${themeIcons[choice]}`);
        $('#themeLabel').text(themeLabels[choice]);
        $('.theme-option').removeClass('active')
            .filter(`[data-theme="${choice}"]`).addClass('active');
    }

    //When an option is clicked, save it and apply it
    $('.theme-option').on('click', function () {
        const choice = $(this).attr('data-theme');
        try {
            localStorage.setItem('theme', choice);
        } catch {
            //Storage can be blocked (e.g. some private windows); the theme still changes
        }
        applyTheme(choice);
    });

    //If the computer switches between light and dark, follow it when System is chosen
    darkQuery.addEventListener('change', () => {
        if (getSavedTheme() === 'system') {
            applyTheme('system');
        }
    });

    //Apply the saved choice when the page loads
    applyTheme(getSavedTheme());
    
});