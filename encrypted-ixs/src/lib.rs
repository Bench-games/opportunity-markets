use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    #[derive(Clone, Copy)]
    pub struct SelectedOption {
        pub selected_option: u64,
    }

    // Stake: encrypt the selected option
    #[instruction]
    pub fn stake(
        input_ctx: Enc<Shared, SelectedOption>,
        stake_recipient_ctx: Shared,
        stake_account_ctx: Shared,
    ) -> (
        // Shared more expensive than mxe btw!
        Enc<Shared, SelectedOption>,  // stake data for user
        Enc<Shared, SelectedOption>,  // stake data for disclosure
    ) {
        let input = input_ctx.to_arcis();
        (
            stake_account_ctx.from_arcis(input),
            stake_recipient_ctx.from_arcis(input),
        )
    }

    // Reveal stake: decrypt option from stake account
    #[instruction]
    pub fn reveal_stake(
        stake_account_ctx: Enc<Shared, SelectedOption>,
    ) -> u64 {
        let stake_data = stake_account_ctx.to_arcis();
        stake_data.selected_option.reveal()
    }
}
