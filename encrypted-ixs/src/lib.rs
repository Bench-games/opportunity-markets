use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    #[derive(Clone, Copy)]
    pub struct SelectedOption {
        pub selected_option: u64,
    }

    // Vouch: encrypt the selected option
    #[instruction]
    pub fn vouch(
        input_ctx: Enc<Shared, SelectedOption>,
        vouch_recipient_ctx: Shared,
        vouch_account_ctx: Shared,
    ) -> (
        // Shared more expensive than mxe btw!
        Enc<Shared, SelectedOption>, // vouch data for user
        Enc<Shared, SelectedOption>, // vouch data for disclosure
    ) {
        let input = input_ctx.to_arcis();
        (
            vouch_account_ctx.from_arcis(input),
            vouch_recipient_ctx.from_arcis(input),
        )
    }

    // Reveal vouch: decrypt option from vouch account
    #[instruction]
    pub fn reveal_vouch(vouch_account_ctx: Enc<Shared, SelectedOption>) -> u64 {
        let vouch_data = vouch_account_ctx.to_arcis();
        vouch_data.selected_option.reveal()
    }
}
